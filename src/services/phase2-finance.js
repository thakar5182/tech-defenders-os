'use strict';
const crypto = require('crypto');
const money = value => Math.round((Number(value) || 0) * 100) / 100;
const periodPattern = /^\d{4}-\d{2}$/;
const taxKeys = ['taxable', 'cgst', 'sgst', 'igst', 'cess', 'grandTotal'];
function amount(row, key) { return money(row?.totals?.[key] ?? row?.[key] ?? 0); }
function summarizeRows(rows = []) {
  return rows.reduce((out, row) => {
    taxKeys.forEach(key => { out[key] = money(out[key] + amount(row, key)); });
    out.documents++; return out;
  }, { documents: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, grandTotal: 0 });
}
function periodRows(rows, orgId, period) {
  if (!periodPattern.test(String(period || ''))) throw Object.assign(new Error('Period must use YYYY-MM format'), { status: 400, expose: true });
  return (rows || []).filter(row => row.orgId === orgId && String(row.date || '').startsWith(period) && !['cancelled', 'void'].includes(row.status));
}
function gstReturn({ invoices = [], purchases = [], orgId, period }) {
  const outward = summarizeRows(periodRows(invoices, orgId, period));
  const inward = summarizeRows(periodRows(purchases, orgId, period));
  const outputTax = money(outward.cgst + outward.sgst + outward.igst + outward.cess);
  const inputTaxCredit = money(inward.cgst + inward.sgst + inward.igst + inward.cess);
  return { period, outward, inward, outputTax, inputTaxCredit, netPayable: money(Math.max(0, outputTax - inputTaxCredit)), excessCredit: money(Math.max(0, inputTaxCredit - outputTax)) };
}
function reconcileGst(book, portal = {}, tolerance = 1) {
  const fields = ['taxable', 'cgst', 'sgst', 'igst', 'cess', 'grandTotal'], differences = {};
  for (const key of fields) differences[key] = money((book?.[key] || 0) - (portal?.[key] || 0));
  const exceptions = fields.filter(key => Math.abs(differences[key]) > tolerance).map(key => ({ field: key, book: money(book?.[key]), portal: money(portal?.[key]), difference: differences[key] }));
  return { matched: exceptions.length === 0, tolerance: money(tolerance), differences, exceptions };
}
function deduction({ kind, taxableAmount, rate, surcharge = 0, cess = 0 }) {
  if (!['tds', 'tcs'].includes(kind)) throw new Error('Deduction kind must be tds or tcs');
  const base = money(taxableAmount), percent = Number(rate);
  if (base <= 0 || percent <= 0 || percent > 100) throw new Error('Positive taxable amount and rate up to 100 are required');
  const tax = money(base * percent / 100), surchargeAmount = money(tax * (Number(surcharge) || 0) / 100), cessAmount = money((tax + surchargeAmount) * (Number(cess) || 0) / 100);
  return { kind, taxableAmount: base, rate: percent, tax, surchargeAmount, cessAmount, total: money(tax + surchargeAmount + cessAmount) };
}
function validatePan(value) { return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(value || '').trim().toUpperCase()); }
function valuation(entries = [], method = 'weighted_average', asOf = null, warehouseId = null) {
  if (!['weighted_average', 'fifo'].includes(method)) throw new Error('Valuation method must be weighted_average or fifo');
  const filtered = entries.filter(row => (!asOf || String(row.date || row.createdAt || '').slice(0, 10) <= asOf) && (!warehouseId || row.warehouseId === warehouseId))
    .slice().sort((a, b) => String(a.date || a.createdAt || '').localeCompare(String(b.date || b.createdAt || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  let qty = 0, value = 0; const layers = [];
  for (const entry of filtered) {
    const movement = Number(entry.qty) || 0;
    if (movement > 0) {
      const rate = Math.max(0, Number(entry.rate) || 0);
      if (method === 'fifo') layers.push({ qty: movement, rate });
      qty += movement; value += movement * rate;
    } else if (movement < 0) {
      let issue = Math.abs(movement);
      if (method === 'weighted_average') { const avg = qty > 0 ? value / qty : 0; value -= Math.min(issue, Math.max(qty, 0)) * avg; qty -= issue; }
      else {
        while (issue > 0 && layers.length) { const take = Math.min(issue, layers[0].qty); layers[0].qty -= take; issue -= take; value -= take * layers[0].rate; if (layers[0].qty <= 0.000001) layers.shift(); }
        qty += movement;
      }
    }
  }
  if (method === 'fifo') value = layers.reduce((sum, layer) => sum + layer.qty * layer.rate, 0);
  return { method, qty: money(qty), rate: qty > 0 ? money(value / qty) : 0, value: money(Math.max(0, value)), negativeStock: qty < 0 };
}
function closingDigest(snapshot) { return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
function journalIssues(journals = []) {
  return journals.flatMap(journal => {
    if (!journal.posted) return [{ journalId: journal.id, issue: 'unposted' }];
    const debit = money((journal.lines || []).reduce((sum, line) => sum + (Number(line.debit) || 0), 0));
    const credit = money((journal.lines || []).reduce((sum, line) => sum + (Number(line.credit) || 0), 0));
    return debit === credit ? [] : [{ journalId: journal.id, issue: 'unbalanced', debit, credit }];
  });
}
module.exports = { money, summarizeRows, gstReturn, reconcileGst, deduction, validatePan, valuation, closingDigest, journalIssues };
