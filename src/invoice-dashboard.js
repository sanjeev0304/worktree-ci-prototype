/**
 * invoice-dashboard.js — UI & Calculation Layer
 *
 * OWNERS: Person B and Person C (bug fixes allowed).
 * Uses core-engine.js through its public functions only.
 */
'use strict';

const core = require('./core-engine');

// Rates used by calculateInvoice(). Must follow RULE #404 in docs/BUSINESS_RULES.md.
const GST_RATE = 0.18; // RULE #404: GST is always exactly 18%
const VIP_DISCOUNT = 0.1; // RULE #404: VIP discount capped at 10%

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Calculates an invoice.
 * @param {Array<{description: string, quantity: number, unitPrice: number}>} items
 * @param {{isVip: boolean}} customer
 */
function calculateInvoice(items, customer) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');

  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const discount = customer && customer.isVip ? subtotal * VIP_DISCOUNT : 0;
  const taxable = subtotal - discount;
  const gst = taxable * GST_RATE;
  const total = taxable + gst;

  return {
    subtotal: round2(subtotal),
    discount: round2(discount),
    taxable: round2(taxable),
    gst: round2(gst),
    total: round2(total),
  };
}

/** Formats an invoice as plain text for the dashboard. */
function renderInvoiceSummary(customer, invoice) {
  return [
    `Invoice for ${customer.name}${customer.isVip ? ' (VIP)' : ''}`,
    `  Subtotal : ${invoice.subtotal.toFixed(2)}`,
    `  Discount : -${invoice.discount.toFixed(2)}`,
    `  GST      : ${invoice.gst.toFixed(2)}`,
    `  Total    : ${invoice.total.toFixed(2)}`,
  ].join('\n');
}

/** End-to-end flow: log in, load the customer, calculate and render the invoice. */
function generateInvoiceForCustomer(email, password, customerId, items) {
  core.connectDatabase();
  const session = core.authenticate(email, password);
  const customer = core.getCustomer(session, customerId);
  const invoice = calculateInvoice(items, customer);
  return { customer, invoice, summary: renderInvoiceSummary(customer, invoice) };
}

module.exports = {
  GST_RATE,
  VIP_DISCOUNT,
  calculateInvoice,
  renderInvoiceSummary,
  generateInvoiceForCustomer,
};

// Allow `node src/invoice-dashboard.js` for a quick demo.
if (require.main === module) {
  const result = generateInvoiceForCustomer('alice@enterprise.com', 'admin123', 'C001', [
    { description: 'Consulting hours', quantity: 10, unitPrice: 100 },
  ]);
  console.log(result.summary);
}
