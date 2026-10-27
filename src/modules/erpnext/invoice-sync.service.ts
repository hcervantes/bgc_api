import { Injectable, Logger } from '@nestjs/common';
import { ErpPlatformService } from './erpnext-platform.service';

/**
 * Phase 2 — mirrors PAID Stripe subscription invoices into the tenant's
 * ERPNext books as submitted Journal Entries.
 *
 * Accounting direction (decided with Hector, Oct 26): the ERPNext Company
 * is the CLIENT's books, and the BGC subscription fee is an EXPENSE for
 * the client — debit "Bookkeeping Fees - <ABBR>", credit "Cash - <ABBR>".
 * Not a Sales Invoice: the client's company never sells anything to
 * itself, so a receivable against itself would be backwards.
 *
 * Stripe stays the billing engine (single source of truth); ERPNext only
 * reflects what was actually paid. Idempotent: the stripe_invoice_id
 * custom field on Journal Entry dedupes under Stripe retries/resends.
 *
 * Spike constraint honored: JEs must balance debit=credit exactly —
 * both lines carry the exact Stripe amount (cents → 2-decimal).
 */
@Injectable()
export class ErpInvoiceSyncService {
  private readonly logger = new Logger(ErpInvoiceSyncService.name);

  constructor(private readonly erp: ErpPlatformService) {}

  /** Same initials algorithm as provisioning's abbrFor — deterministic. */
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

  async syncPaidInvoice(
    client: { erpCompanyName: string; slug: string },
    inv: { id: string; amountPaidCents: number; paidAt: Date },
  ): Promise<void> {
    await this.erp.ensureJournalEntryCustomField();

    const existing = await this.erp.findJournalEntryByStripeId(inv.id);
    if (existing) {
      if (existing.docstatus === 0) {
        // Draft from a crash between create and submit — resume it.
        this.logger.log('Invoice ' + inv.id + ' found as DRAFT Journal Entry ' + existing.name + ' — submitting');
        await this.erp.submitJournalEntry(existing.name);
        return;
      }
      this.logger.log('Invoice ' + inv.id + ' already mirrored as Journal Entry ' + existing.name + ' — skipping');
      return;
    }

    const rate = inv.amountPaidCents / 100; // exact cents → 2-decimal
    const abbr = this.abbrFor(client.erpCompanyName);
    const expenseAccount = await this.erp.ensureExpenseAccount(client.erpCompanyName, abbr);

    const jeName = await this.erp.createJournalEntry({
      company: client.erpCompanyName,
      posting_date: inv.paidAt.toISOString().slice(0, 10),
      voucher_type: 'Journal Entry',
      user_remark: 'BGC Tax Preparers subscription — Stripe invoice ' + inv.id,
      stripe_invoice_id: inv.id,
      accounts: [
        { account: expenseAccount, debit_in_account_currency: rate, credit_in_account_currency: 0 },
        { account: 'Cash - ' + abbr, debit_in_account_currency: 0, credit_in_account_currency: rate },
      ],
    });
    await this.erp.submitJournalEntry(jeName);

    this.logger.log(
      'Mirrored Stripe invoice ' + inv.id + ' → Journal Entry ' + jeName + ' (Bookkeeping Fees ' + rate.toFixed(2) + ', ' + client.erpCompanyName + ')',
    );
  }
}
