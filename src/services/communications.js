'use strict';

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const store = require('../../db/store');
const EmailService = require('./email-service');
const { audit } = require('../util');

const TEMPLATE_VARS = new Set(['customer_name', 'company_name', 'invoice_number', 'invoice_date', 'invoice_total', 'invoice_amount', 'due_date', 'invoice_due_date', 'payment_link', 'sales_person', 'quotation_number', 'ticket_number', 'ticket_status', 'ticket_priority', 'payment_amount', 'payment_date', 'renewal_date', 'assigned_user', 'portal_url', 'invoice_url', 'quotation_url', 'ticket_url', 'company_logo']);
let workerRunning = false;

const clean = (value, max = 20000) => String(value == null ? '' : value).trim().slice(0, max);
const secret = () => String(process.env.INVOICE_LINK_SECRET || process.env.JWT_SECRET || 'development-only-invoice-link-secret');
const b64url = value => Buffer.from(value).toString('base64url');

function signPayload(payload, purpose) {
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', `${purpose}:${secret()}`).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyPayload(token, purpose) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', `${purpose}:${secret()}`).update(body).digest('base64url');
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (_) { return null; }
}

function invoiceToken(orgId, invoiceId, days = 7) {
  return signPayload({ orgId, invoiceId, exp: Date.now() + Math.min(30, Math.max(1, Number(days) || 7)) * 86400000 }, 'invoice');
}

function unsubscribeToken(orgId, customerId) {
  return signPayload({ orgId, customerId }, 'unsubscribe');
}

function renderTemplate(text, variables) {
  return clean(text).replace(/{{\s*([a-z_]+)\s*}}/gi, (match, key) => TEMPLATE_VARS.has(key) ? clean(variables[key], 2000) : match);
}

const htmlEsc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function sanitizeHtml(value) {
  return clean(value, 50_000)
    .replace(/<\/?(?:script|iframe|object|embed|form|input|button)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(["']).*?\1/gi, '')
    .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, '');
}
function renderHtmlTemplate(html, variables) {
  return sanitizeHtml(html).replace(/{{\s*([a-z_]+)\s*}}/gi, (match, key) => TEMPLATE_VARS.has(key) ? htmlEsc(clean(variables[key], 2000)) : match);
}
function emailHtml(content, vars, options = {}) {
  const body = renderHtmlTemplate(content, vars).replace(/\n/g, '<br>');
  const action = options.actionUrl ? `<a href="${htmlEsc(options.actionUrl)}" style="display:inline-block;background:#c89b19;color:#15130e;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px">${htmlEsc(options.actionLabel || 'Open Tech Defenders OS')}</a>` : '';
  const unsubscribe = options.unsubscribeUrl ? `<p style="margin:22px 0 0;font-size:12px;color:#777">You received this marketing email from ${htmlEsc(vars.company_name)}. <a href="${htmlEsc(options.unsubscribeUrl)}" style="color:#8b6810">Unsubscribe</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f2ed;font-family:Arial,Helvetica,sans-serif;color:#24211c"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f2ed;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid #e7e1d7;border-radius:12px;overflow:hidden"><tr><td style="background:#17150f;padding:24px 28px"><div style="font-size:11px;letter-spacing:2px;font-weight:700;color:#d7ad2b">TECH DEFENDERS</div><div style="font-size:21px;font-weight:700;color:#fff;margin-top:5px">Business OS</div></td></tr><tr><td style="padding:32px 28px"><div style="font-size:15px;line-height:1.65">${body}</div>${action}${unsubscribe}</td></tr><tr><td style="padding:18px 28px;background:#fbfaf7;border-top:1px solid #eee7dc;font-size:12px;color:#777">Tech Defenders · Secure business operations</td></tr></table></td></tr></table></body></html>`;
}

function variablesFor(org, customer, input = {}) {
  const invoice = input.invoice || null;
  return {
    customer_name: customer ? customer.name : input.customerName || '', company_name: org.name || org.legalName || 'Tech Defenders',
    invoice_number: invoice ? invoice.number : input.invoiceNumber || '', invoice_date: invoice ? invoice.date : input.invoiceDate || '',
    invoice_total: invoice ? String(invoice.totals?.grandTotal || 0) : String(input.invoiceTotal || ''),
    due_date: invoice ? invoice.dueDate || '' : input.dueDate || '', invoice_due_date: invoice ? invoice.dueDate || '' : input.dueDate || '',
    invoice_amount: invoice ? String(invoice.totals?.grandTotal || 0) : String(input.invoiceTotal || ''), payment_link: input.paymentLink || '', sales_person: input.salesPerson || '',
    quotation_number: input.quotationNumber || '', ticket_number: input.ticketNumber || '', ticket_status: input.ticketStatus || '', ticket_priority: input.ticketPriority || '',
    payment_amount: input.paymentAmount || '', payment_date: input.paymentDate || '', renewal_date: input.renewalDate || '', assigned_user: input.assignedUser || '',
    portal_url: input.portalUrl || '', invoice_url: input.invoiceUrl || input.paymentLink || '', quotation_url: input.quotationUrl || '', ticket_url: input.ticketUrl || '', company_logo: input.companyLogo || ''
  };
}

function invoicePdf(invoice, customer, org) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 46, info: { Title: `Invoice ${invoice.number}`, Author: org.name || 'Tech Defenders' } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.fontSize(20).fillColor('#111827').text(org.name || 'Tech Defenders', { align: 'right' });
    doc.moveDown(0.3).fontSize(10).fillColor('#6b7280').text(org.legalName || '').text(org.gstin ? `GSTIN: ${org.gstin}` : '');
    doc.moveDown(1).fontSize(24).fillColor('#b38728').text('TAX INVOICE');
    doc.fontSize(11).fillColor('#111827').text(`Invoice: ${invoice.number}`).text(`Date: ${invoice.date || '-'}`).text(`Due: ${invoice.dueDate || '-'}`);
    doc.moveDown().fontSize(12).text(`Bill to: ${customer?.name || 'Customer'}`).fontSize(10).text(customer?.gstin ? `GSTIN: ${customer.gstin}` : '').text(customer?.email || '').text(customer?.phone || '');
    doc.moveDown();
    const startY = doc.y;
    doc.fontSize(10).fillColor('#ffffff').rect(46, startY, 503, 24).fill('#111827');
    doc.fillColor('#ffffff').text('Description', 56, startY + 7).text('Qty', 330, startY + 7).text('Rate', 385, startY + 7).text('Amount', 470, startY + 7);
    let y = startY + 32;
    for (const line of (invoice.lines || []).slice(0, 50)) {
      doc.fillColor('#111827').text(clean(line.name, 60), 56, y, { width: 250 }).text(String(line.qty || 0), 330, y).text(String(line.rate || 0), 385, y).text(String(line.lineTotal || 0), 470, y);
      y += 22; if (y > 720) { doc.addPage(); y = 60; }
    }
    doc.moveTo(330, y + 8).lineTo(549, y + 8).strokeColor('#d1d5db').stroke();
    doc.fontSize(12).fillColor('#111827').text(`Grand Total: INR ${Number(invoice.totals?.grandTotal || 0).toFixed(2)}`, 330, y + 18, { width: 219, align: 'right' });
    doc.moveDown(4).fontSize(9).fillColor('#6b7280').text('Generated securely by Tech Defenders OS.');
    doc.end();
  });
}

function queueEmail(org, actor, input) {
  // Fail before creating a campaign when email is disabled for the workspace
  // or its Render-only provider configuration is incomplete.
  EmailService.validateConfiguration(org.id);
  const customers = (input.customerIds || []).map(id => store.findOne('customers', item => item.id === id && item.orgId === org.id)).filter(Boolean);
  const direct = input.to ? [{ id: null, name: input.name || '', email: input.to, marketingOptOut: false }] : [];
  const recipients = [...customers, ...direct].filter((item, index, all) => item.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(item.email, 180)) && all.findIndex(other => clean(other.email, 180).toLowerCase() === clean(item.email, 180).toLowerCase()) === index);
  if (!recipients.length) throw new Error('Select at least one customer with a valid email address');
  if (recipients.length > (Number(process.env.EMAIL_CAMPAIGN_MAX_RECIPIENTS) || 5000)) throw new Error('Campaign recipient limit exceeded');
  const template = input.templateId ? store.findOne('emailTemplates', item => item.id === input.templateId && item.orgId === org.id) : null;
  const campaign = store.insert('emailCampaigns', {
    orgId: org.id, number: `EMC-${Date.now()}`, name: clean(input.name || input.subject || 'Email campaign', 180),
    type: input.type === 'marketing' ? 'marketing' : 'transactional', templateId: template?.id || null,
    subject: clean(input.subject || template?.subject, 180), body: clean(input.body || template?.body),
    status: input.scheduledAt && new Date(input.scheduledAt) > new Date() ? 'scheduled' : 'queued',
    scheduledAt: input.scheduledAt || new Date().toISOString(), total: recipients.length, queued: 0, sent: 0, failed: 0, skipped: 0, requestedBy: actor.id,
    invoiceId: input.invoiceId || null, attachInvoice: input.attachInvoice === true,
    publicBaseUrl: clean(input.publicBaseUrl || process.env.PUBLIC_APP_URL, 300).replace(/\/$/, '')
  });
  for (const customer of recipients) {
    const suppressed = store.findOne('emailSuppressions', item => item.orgId === org.id && clean(item.email, 180).toLowerCase() === clean(customer.email, 180).toLowerCase());
    if ((campaign.type === 'marketing' && customer.marketingOptOut) || suppressed) { campaign.skipped += 1; continue; }
    store.insert('emailQueue', {
      orgId: org.id, campaignId: campaign.id, customerId: customer.id || null, to: clean(customer.email, 180), recipientName: clean(customer.name, 120),
      status: 'queued', scheduledAt: campaign.scheduledAt, attempts: 0, maxAttempts: 3, idempotencyKey: `campaign:${campaign.id}:${crypto.createHash('sha256').update(customer.email.toLowerCase()).digest('hex').slice(0, 20)}`
    });
    campaign.queued += 1;
  }
  store.update('emailCampaigns', campaign.id, { queued: campaign.queued, skipped: campaign.skipped });
  audit(org.id, actor.id, 'queue_bulk_email', 'email_campaign', campaign.id, { recipients: recipients.length, scheduledAt: campaign.scheduledAt });
  return campaign;
}

async function processEmailJob(job) {
  const campaign = store.byId('emailCampaigns', job.campaignId);
  const org = store.byId('organizations', job.orgId);
  const customer = job.customerId ? store.byId('customers', job.customerId) : { name: job.recipientName, email: job.to };
  if (!campaign || !org || campaign.orgId !== job.orgId) throw new Error('Campaign configuration is no longer available');
  const invoice = campaign.invoiceId ? store.findOne('invoices', item => item.id === campaign.invoiceId && item.orgId === job.orgId) : null;
  const invoiceLink = invoice ? `${campaign.publicBaseUrl || ''}/api/ops/public/invoices/${invoiceToken(job.orgId, invoice.id)}.pdf` : '';
  const vars = variablesFor(org, customer, { invoice, paymentLink: invoiceLink });
  let body = renderTemplate(campaign.body, vars);
  const unsubscribeUrl = campaign.type === 'marketing' && customer?.id ? `${campaign.publicBaseUrl || ''}/api/ops/public/unsubscribe/${unsubscribeToken(job.orgId, customer.id)}` : '';
  if (unsubscribeUrl) body += `\n\nTo stop marketing email, use your secure unsubscribe link: ${unsubscribeUrl}`;
  const attachments = [];
  if (campaign.attachInvoice && invoice) attachments.push({ name: `${invoice.number}.pdf`, content: (await invoicePdf(invoice, customer, org)).toString('base64') });
  const result = await EmailService.sendTemplateEmail({ orgId: job.orgId, to: job.to, name: customer?.name || job.recipientName, subject: renderTemplate(campaign.subject, vars), text: body, html: emailHtml(campaign.body, vars, { unsubscribeUrl, actionUrl: vars.invoice_url, actionLabel: 'View invoice' }), attachments });
  const delivery = store.insert('messageDeliveries', { orgId: job.orgId, channel: 'email', idempotencyKey: job.idempotencyKey, recipient: result.recipient, reference: campaign.number, status: result.status, provider: result.provider, providerId: result.providerId, requestedBy: campaign.requestedBy, attemptCount: job.attempts + 1, acceptedAt: new Date().toISOString() });
  store.insert('communicationLogs', { orgId: job.orgId, customerId: job.customerId, channel: 'email', messageType: campaign.type === 'marketing' ? 'campaign' : (invoice ? 'invoice' : 'email'), relatedInvoiceId: invoice?.id || null, status: result.status, initiatedBy: campaign.requestedBy, campaignId: campaign.id, deliveryId: delivery.id, subject: campaign.subject });
  return result;
}

async function runEmailWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const now = new Date();
    const jobs = store.find('emailQueue', item => ['queued', 'retry'].includes(item.status) && new Date(item.nextAttemptAt || item.scheduledAt || 0) <= now).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, Number(process.env.EMAIL_WORKER_BATCH) || 10);
    for (const job of jobs) {
      const campaign = store.byId('emailCampaigns', job.campaignId);
      store.update('emailQueue', job.id, { status: 'sending', attempts: job.attempts + 1, lastAttemptAt: new Date().toISOString() });
      try {
        const result = await processEmailJob(job);
        store.update('emailQueue', job.id, { status: 'sent', providerId: result.providerId, sentAt: new Date().toISOString(), error: null });
        if (campaign) store.update('emailCampaigns', campaign.id, { sent: (campaign.sent || 0) + 1, status: (campaign.sent || 0) + 1 + (campaign.failed || 0) >= campaign.queued ? 'completed' : 'sending' });
      } catch (error) {
        const current = store.byId('emailQueue', job.id) || job;
        const retry = current.attempts < current.maxAttempts;
        store.update('emailQueue', job.id, { status: retry ? 'retry' : 'failed', error: clean(error.message, 300), nextAttemptAt: retry ? new Date(Date.now() + Math.pow(2, current.attempts) * 60000).toISOString() : null });
        if (!retry && campaign) store.update('emailCampaigns', campaign.id, { failed: (campaign.failed || 0) + 1, status: (campaign.sent || 0) + (campaign.failed || 0) + 1 >= campaign.queued ? 'completed_with_failures' : 'sending' });
      }
    }
  } finally { workerRunning = false; }
}

function communicationTimeline(orgId, customerId) {
  return store.find('communicationLogs', item => item.orgId === orgId && (!customerId || item.customerId === customerId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

module.exports = { TEMPLATE_VARS, signPayload, verifyPayload, invoiceToken, unsubscribeToken, renderTemplate, renderHtmlTemplate, sanitizeHtml, emailHtml, variablesFor, invoicePdf, queueEmail, runEmailWorker, communicationTimeline };
