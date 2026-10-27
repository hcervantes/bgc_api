import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ErpPlatformService } from '../erpnext/erpnext-platform.service';
import { CreateEntryDto, EntryType } from './create-entry.dto';

// Entry type → ERPNext root_type on the tenant's chart.
// root_type is the robust discriminator: EVERY account has one from its
// position in the chart, whereas account_type is only set on special
// accounts (Cash/Bank/etc.) — the standard CoA leaves ordinary expense
// and income accounts untyped, so filtering on account_type yields empty
// category dropdowns.
const ROOT_TYPE_BY_ENTRY: Record<EntryType, string> = {
  expense: 'Expense',
  income: 'Income',
  asset: 'Asset',
};

// Asset categories exclude the company's own liquid/operating accounts —
// "what your business owns" is equipment, vehicles, etc., not its own cash.
const ASSET_EXCLUDED_TYPES = ['Cash', 'Bank', 'Receivable', 'Payable', 'Stock'];

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
    if (!(type in ROOT_TYPE_BY_ENTRY)) {
      throw new BadRequestException('type must be expense, income, or asset');
    }
    const client = await this.loadTenantBook(tenant);
    const filters: unknown[][] = [
      ['Account', 'company', '=', client.erpCompanyName],
      ['Account', 'root_type', '=', ROOT_TYPE_BY_ENTRY[type as EntryType]],
      ['Account', 'is_group', '=', 0],
    ];
    if (type === 'asset') {
      filters.push(['Account', 'account_type', 'not in', ASSET_EXCLUDED_TYPES]);
    }
    const rows = await this.erp.listResource<{ name: string; account_name: string }>({
      doctype: 'Account',
      filters,
      fields: ['name', 'account_name'],
    });
    return rows.map((a) => ({ name: a.name, label: a.account_name }));
  }

  async createEntry(
    tenant: { clientId: string },
    portalUserId: string,
    dto: CreateEntryDto,
  ): Promise<{ journalEntry: string }> {
    const client = await this.loadTenantBook(tenant);
    const expectedRoot = ROOT_TYPE_BY_ENTRY[dto.type];

    // Cross-tenant guarantee: the account must exist AND belong to the
    // tenant's Company with the expected root_type (and, for assets, not
    // be a liquid/operating account). Foreign account → 404
    // (anti-enumeration), never a write.
    const account = await this.erp.getResource<{
      company?: string;
      root_type?: string;
      account_type?: string;
    }>('Account', dto.accountName);
    if (
      account?.company !== client.erpCompanyName ||
      account?.root_type !== expectedRoot ||
      (dto.type === 'asset' && ASSET_EXCLUDED_TYPES.includes(account.account_type ?? ''))
    ) {
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
    const rows = await this.erp.listResource<Record<string, unknown>>({
      doctype: 'Journal Entry',
      filters: [
        ['Journal Entry', 'company', '=', client.erpCompanyName],
        ['Journal Entry', 'portal_entry', '=', 1],
      ],
      // Journal Entry has no "total" field — total_debit is the entry
      // amount (debit and credit always balance).
      fields: ['name', 'posting_date', 'user_remark', 'total_debit', 'docstatus'],
      orderBy: 'posting_date desc',
      limit: 50,
    });
    return rows.map((je) => ({
      id: je.name as string,
      date: je.posting_date as string,
      description: (je.user_remark as string) ?? '',
      total: Number(je.total_debit ?? 0),
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
      await this.erp.ensureCustomField({
        docname: f.docname,
        dt: 'Journal Entry',
        fieldname: f.fieldname,
        label: f.label,
        fieldtype: f.fieldtype,
        insertAfter: 'stripe_invoice_id',
      });
    }
  }
}
