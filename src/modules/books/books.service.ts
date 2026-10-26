import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ErpPlatformService } from '../erpnext/erpnext-platform.service';
import { CreateEntryDto, EntryType } from './create-entry.dto';

// Entry type → ERPNext account_type on the tenant's chart.
const ACCOUNT_TYPE_BY_ENTRY: Record<EntryType, string> = {
  expense: 'Expense Account',
  income: 'Income Account',
  asset: 'Fixed Asset',
};

/**
 * Phase 4 — Standard-tier customer self-entry.
 *
 * Security model (the cross-tenant guarantee):
 * - The tenant Company name comes ONLY from the authenticated session's
 *   Client row (TenantGuard) — never from the request body.
 * - accountName is resolved against ERPNext and MUST belong to that
 *   Company with the expected account_type; anything else is 404'd as
 *   anti-enumeration, exactly like TenantGuard does for client slugs.
 * - Every created Journal Entry is tagged (portal_entry, portal_user_id)
 *   and audited in the AuditLog.
 */
@Injectable()
export class BooksService {
  private readonly logger = new Logger(BooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpPlatformService,
  ) {}

  /** Same initials algorithm as provisioning/invoice-sync — deterministic. */
  private abbrFor(name: string): string {
    const abbr = name
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 5);
    return abbr || 'BGC';
  }

  /** Tenant Client row with bookkeeping live — else anti-enumeration 404. */
  private async loadTenantBook(tenant: { clientId: string }) {
    const client = await this.prisma.client.findUnique({ where: { id: tenant.clientId } });
    if (!client?.bookkeepingEnabled || !client.erpCompanyName) {
      // Not an error state to reveal: same 404 as a non-member tenant.
      throw new NotFoundException('BOOKKEEPING_NOT_ENABLED');
    }
    return client;
  }

  async listAccounts(tenant: { clientId: string }, type: string): Promise<Array<{ name: string; label: string }>> {
    if (!(type in ACCOUNT_TYPE_BY_ENTRY)) {
      throw new BadRequestException('type must be expense, income, or asset');
    }
    const client = await this.loadTenantBook(tenant);
    const filters = JSON.stringify([
      ['Account', 'company', '=', client.erpCompanyName],
      ['Account', 'account_type', '=', ACCOUNT_TYPE_BY_ENTRY[type as EntryType]],
      ['Account', 'is_group', '=', 0],
    ]);
    const fields = JSON.stringify(['name', 'account_name']);
    const res = (await this.erp.request(
      'GET',
      '/api/resource/Account?filters=' +
        encodeURIComponent(filters) +
        '&fields=' +
        encodeURIComponent(fields) +
        '&limit_page_length=0',
    )) as { data?: Array<{ name: string; account_name: string }> };
    return (res?.data ?? []).map((a) => ({ name: a.name, label: a.account_name }));
  }

  async createEntry(
    tenant: { clientId: string },
    portalUserId: string,
    dto: CreateEntryDto,
  ): Promise<{ journalEntry: string }> {
    const client = await this.loadTenantBook(tenant);
    const expectedType = ACCOUNT_TYPE_BY_ENTRY[dto.type];

    // Cross-tenant guarantee: the account must exist AND belong to the
    // tenant's Company with the expected account_type. Foreign account →
    // 404 (anti-enumeration), never a write.
    const account = (await this.erp.request(
      'GET',
      '/api/resource/Account/' + encodeURIComponent(dto.accountName),
    )) as { company?: string; account_type?: string };
    if (account?.company !== client.erpCompanyName || account?.account_type !== expectedType) {
      throw new NotFoundException('ACCOUNT_NOT_FOUND');
    }

    await this.ensurePortalCustomFields();

    const rate = dto.amountCents / 100; // exact cents → 2-decimal
    const abbr = this.abbrFor(client.erpCompanyName);
    const cash = 'Cash - ' + abbr;

    // expense/asset: money out (debit the account, credit Cash);
    // income: money in (debit Cash, credit the account).
    const lines =
      dto.type === 'income'
        ? [
            { account: cash, debit_in_account_currency: rate, credit_in_account_currency: 0 },
            { account: dto.accountName, debit_in_account_currency: 0, credit_in_account_currency: rate },
          ]
        : [
            { account: dto.accountName, debit_in_account_currency: rate, credit_in_account_currency: 0 },
            { account: cash, debit_in_account_currency: 0, credit_in_account_currency: rate },
          ];

    const name = await this.erp.createJournalEntry({
      company: client.erpCompanyName,
      posting_date: dto.date,
      voucher_type: 'Journal Entry',
      user_remark: dto.description,
      portal_entry: 1,
      portal_user_id: portalUserId,
      accounts: lines,
    });
    await this.erp.submitJournalEntry(name);

    await this.prisma.auditLog.create({
      data: {
        userId: portalUserId,
        clientId: client.id,
        action: 'books.entry.created',
        targetId: name,
      },
    });

    this.logger.log(
      'Portal entry by ' + portalUserId + ' → JE ' + name + ' (' + dto.type + ', ' + rate.toFixed(2) + ', ' + client.erpCompanyName + ')',
    );
    return { journalEntry: name };
  }

  async listEntries(tenant: { clientId: string }): Promise<
    Array<{ id: string; date: string; description: string; total: number; status: string }>
  > {
    const client = await this.loadTenantBook(tenant);
    const filters = JSON.stringify([
      ['Journal Entry', 'company', '=', client.erpCompanyName],
      ['Journal Entry', 'portal_entry', '=', 1],
    ]);
    const fields = JSON.stringify(['name', 'posting_date', 'user_remark', 'total', 'docstatus']);
    const res = (await this.erp.request(
      'GET',
      '/api/resource/Journal Entry?filters=' +
        encodeURIComponent(filters) +
        '&fields=' +
        encodeURIComponent(fields) +
        '&order_by=posting_date desc&limit_page_length=50',
    )) as { data?: Array<Record<string, unknown>> };
    return (res?.data ?? []).map((je) => ({
      id: je.name as string,
      date: je.posting_date as string,
      description: (je.user_remark as string) ?? '',
      total: Number(je.total ?? 0),
      status: je.docstatus === 1 ? 'submitted' : 'draft',
    }));
  }

  /** Custom Fields tagging portal-created entries (idempotent). */
  private async ensurePortalCustomFields(): Promise<void> {
    const fields = [
      {
        docname: 'Journal Entry-portal_entry',
        fieldname: 'portal_entry',
        label: 'Portal Entry',
        fieldtype: 'Check',
      },
      {
        docname: 'Journal Entry-portal_user_id',
        fieldname: 'portal_user_id',
        label: 'Portal User',
        fieldtype: 'Data',
      },
    ];
    for (const f of fields) {
      try {
        await this.erp.request('GET', '/api/resource/Custom Field/' + encodeURIComponent(f.docname));
      } catch {
        await this.erp.request('POST', '/api/resource/Custom Field', {
          dt: 'Journal Entry',
          fieldname: f.fieldname,
          label: f.label,
          fieldtype: f.fieldtype,
          insert_after: 'stripe_invoice_id',
          read_only: 1,
        });
        this.logger.log('Created Custom Field Journal Entry.' + f.fieldname);
      }
    }
  }
}
