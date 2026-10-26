import { Injectable, Logger } from '@nestjs/common';
import { ErpPlatformService } from './erpnext-platform.service';

const ITEM_CODE = 'Bookkeeping Subscription';

/**
 * Phase 2 — mirrors PAID Stripe subscription invoices into the tenant's
 * ERPNext books as submitted Sales Invoices.
 *
 * Deliberately NOT an ERPNext Subscription doc with invoice generation:
 * Stripe is the billing engine (single source of truth); ERPNext only
 * reflects what was actually paid. Two invoice generators would
 * double-bill the books.
 *
 * Idempotent: every mirrored Sales Invoice carries the Stripe invoice id
 * in the stripe_invoice_id custom field; a replay (Stripe retry, manual
 * resend) finds the existing invoice and skips.
 */
@Injectable()
export class ErpInvoiceSyncService {
  private readonly logger = new Logger(ErpInvoiceSyncService.name);

  constructor(private readonly erp: ErpPlatformService) {}

  async syncPaidInvoice(
    client: { erpCompanyName: string; slug: string },
    inv: { id: string; amountPaidCents: number; paidAt: Date },
  ): Promise<void> {
    await this.erp.ensureSalesInvoiceCustomField();

    const existing = await this.erp.findSalesInvoiceByStripeId(inv.id);
    if (existing) {
      this.logger.log('Invoice ' + inv.id + ' already mirrored as Sales Invoice ' + existing + ' — skipping');
      return;
    }

    // Spike rounding finding: ERPNext rounds at line level — always send
    // pre-rounded 2-decimal values (Stripe amounts are exact cents).
    const rate = inv.amountPaidCents / 100;

    const customer = await this.erp.ensureCustomer(client.erpCompanyName);
    await this.erp.ensureItem(ITEM_CODE);

    const name = await this.erp.createSalesInvoice({
      customer,
      company: client.erpCompanyName,
      posting_date: inv.paidAt.toISOString().slice(0, 10),
      items: [{ item_code: ITEM_CODE, qty: 1, rate }],
      stripe_invoice_id: inv.id,
    });
    await this.erp.submitSalesInvoice(name);

    this.logger.log(
      'Mirrored Stripe invoice ' + inv.id + ' → Sales Invoice ' + name + ' (' + rate.toFixed(2) + ', ' + client.erpCompanyName + ')',
    );
  }
}
