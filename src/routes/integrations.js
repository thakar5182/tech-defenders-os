/** Tech Defenders OS live communication and GST integration routes. */
'use strict';
const express = require('express');
const crypto = require('crypto');
const store = require('../../db/store');
const { requireAuth } = require('../middleware');
const { audit, can, r2 } = require('../util');
const providers = require('../services/integrations');

const router = express.Router();
const now = () => new Date().toISOString();
const clean = providers.clean;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function webhookTokenValid(req, expected) {
  if (!expected) return false;
  return safeEqual(req.get('X-TD-Webhook-Token') || req.query.token, expected);
}

function webhookSummary(provider, body) {
  if (provider === 'meta') {
    const status = body?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
    return { providerId: clean(status?.id, 300), status: clean(status?.status, 60), event: 'message_status' };
  }
  if (provider === 'brevo') {
    return { providerId: clean(body?.['message-id'] || body?.messageId, 300), status: clean(body?.event, 60), event: clean(body?.event, 60) };
  }
  return {
    providerId: clean(body?.request_id || body?.requestId || body?.messageId, 300),
    status: clean(body?.status || body?.event, 60), event: clean(body?.event || 'delivery_status', 60)
  };
}

function deliveryStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['delivered', 'read', 'opened', 'click'].includes(status)) return status === 'click' ? 'opened' : status;
  if (['failed', 'undelivered', 'invalid', 'blocked', 'bounced', 'hard_bounce', 'soft_bounce'].includes(status)) return 'failed';
  if (['sent', 'accepted', 'queued'].includes(status)) return status;
  return 'provider_update';
}

function recordWebhook(provider, summary, req) {
  const matched = summary.providerId
    ? store.findOne('messageDeliveries', item => item.providerId === summary.providerId)
    : null;
  const event = store.insert('providerWebhooks', {
    orgId: matched ? matched.orgId : null,
    provider, providerId: summary.providerId || null,
    event: summary.event || 'delivery_status', status: summary.status || '',
    bodyHash: providers.payloadHash(req.body || {}), requestId: req.requestId || null
  });
  if (matched) {
    store.update('messageDeliveries', matched.id, {
      status: deliveryStatus(summary.status), lastProviderEvent: summary.event,
      lastProviderEventAt: now(), webhookEventId: event.id
    });
  }
  return { event, matched: !!matched };
}

/* Public provider callbacks: signatures/tokens are verified before recording. */
router.get('/webhooks/meta', (req, res) => {
  const valid = req.query['hub.mode'] === 'subscribe' &&
    safeEqual(req.query['hub.verify_token'], process.env.META_WEBHOOK_VERIFY_TOKEN) &&
    process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!valid) return res.status(403).send('Verification failed');
  res.status(200).send(String(req.query['hub.challenge'] || ''));
});

router.post('/webhooks/meta', (req, res) => {
  if (!process.env.META_APP_SECRET || !req.rawBody) return res.status(503).json({ error: 'Meta webhook signature verification is not configured' });
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(req.rawBody).digest('hex');
  if (!safeEqual(req.get('X-Hub-Signature-256'), expected)) return res.status(401).json({ error: 'Invalid webhook signature' });
  recordWebhook('meta', webhookSummary('meta', req.body), req);
  res.json({ received: true });
});

router.post('/webhooks/brevo', (req, res) => {
  if (!webhookTokenValid(req, process.env.BREVO_WEBHOOK_TOKEN)) return res.status(401).json({ error: 'Invalid webhook token' });
  recordWebhook('brevo', webhookSummary('brevo', req.body), req);
  res.json({ received: true });
});

router.post('/webhooks/msg91', (req, res) => {
  if (!webhookTokenValid(req, process.env.MSG91_WEBHOOK_TOKEN)) return res.status(401).json({ error: 'Invalid webhook token' });
  recordWebhook('msg91', webhookSummary('msg91', req.body), req);
  res.json({ received: true });
});

router.use(requireAuth);

function requireAny(modules, action) {
  return (req, res, next) => modules.some(module => can(req.user, module, action))
    ? next()
    : res.status(403).json({ error: `Permission denied: ${modules.join(' or ')}:${action}` });
}

const requireAdminView = requireAny(['admin'], 'view');
const requireAdminEdit = requireAny(['admin'], 'edit');
const requireCommunication = requireAny(['sales', 'service', 'admin'], 'edit');
const requireGstAction = requireAny(['sales', 'finance', 'admin'], 'edit');

router.get('/status', requireAdminView, (req, res) => {
  res.json({ integrations: providers.PROVIDERS.map(item => providers.providerState(req.org.id, item)) });
});

router.patch('/:provider', requireAdminEdit, (req, res) => {
  if (req.body.apiKey || req.body.token || req.body.secret || req.body.password) {
    return res.status(400).json({ error: 'Secrets must be configured in Render environment variables, not stored in the application database' });
  }
  try {
    const result = providers.setProviderEnabled(req.org.id, req.params.provider, req.body.enabled, req.user.id);
    audit(req.org.id, req.user.id, 'configure', 'integration', result.config.id, { provider: req.params.provider, enabled: result.config.enabled });
    res.json({ integration: result.state });
  } catch (error) { nextProviderError(error, res); }
});

function idempotencyKey(req, channel, fallback) {
  return clean(req.get('Idempotency-Key') || req.body?.idempotencyKey || fallback || crypto.randomUUID(), 200);
}

function existingDelivery(orgId, channel, key) {
  return store.findOne('messageDeliveries', item => item.orgId === orgId && item.channel === channel && item.idempotencyKey === key);
}

async function runDelivery(req, res, channel, send) {
  const key = idempotencyKey(req, channel);
  const previous = existingDelivery(req.org.id, channel, key);
  if (previous) return res.json({ delivery: previous, duplicate: true });
  const delivery = store.insert('messageDeliveries', {
    orgId: req.org.id, channel, idempotencyKey: key,
    recipient: providers.maskRecipient(req.body.to), reference: clean(req.body.reference, 180),
    status: 'sending', provider: null, providerId: null, requestedBy: req.user.id,
    attemptCount: 1, requestId: req.requestId
  });
  try {
    const result = await send({ ...req.body, orgId: req.org.id });
    const updated = store.update('messageDeliveries', delivery.id, {
      status: result.status, provider: result.provider, providerId: result.providerId,
      recipient: result.recipient, acceptedAt: now(), errorCode: null, error: null
    });
    audit(req.org.id, req.user.id, 'send', `${channel}_message`, updated.id, { provider: result.provider, reference: updated.reference });
    res.status(202).json({ delivery: updated, duplicate: false });
  } catch (error) {
    providers.markProvider(req.org.id, channel, false, error.message);
    store.update('messageDeliveries', delivery.id, {
      status: 'failed', failedAt: now(), errorCode: error.code || 'PROVIDER_ERROR', error: clean(error.message, 300)
    });
    nextProviderError(error, res);
  }
}

router.post('/email/send', requireCommunication, (req, res) => runDelivery(req, res, 'email', providers.sendEmail));
router.post('/sms/send', requireCommunication, (req, res) => runDelivery(req, res, 'sms', providers.sendSms));
router.post('/whatsapp/send', requireCommunication, (req, res) => runDelivery(req, res, 'whatsapp', providers.sendWhatsApp));

router.get('/deliveries', requireAdminView, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const deliveries = store.find('messageDeliveries', item => item.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  res.json({ deliveries });
});

router.post('/gst/verify', requireAdminEdit, async (req, res) => {
  try {
    const result = await providers.gstAuthenticate(req.org.id, req.org.gstin, true);
    audit(req.org.id, req.user.id, 'verify', 'gst_integration', req.org.id, { gstin: providers.maskRecipient(result.gstin) });
    res.json({ verified: true, gstin: providers.maskRecipient(result.gstin), checkedAt: now() });
  } catch (error) { providers.markProvider(req.org.id, 'gst', false, error.message); nextProviderError(error, res); }
});

function dateForIrp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

function irpAddress(source) {
  const address = source.address || source.billingAddress || {};
  return {
    Addr1: clean(address.line1, 100), Loc: clean(address.city, 50),
    Pin: Number(String(address.pincode || '').replace(/\D/g, '')),
    Stcd: clean(source.stateCode || String(source.gstin || '').slice(0, 2), 2)
  };
}

const UOM = { nos: 'NOS', no: 'NOS', pcs: 'PCS', pc: 'PCS', kg: 'KGS', kgs: 'KGS', mtr: 'MTR', metre: 'MTR', set: 'SET', box: 'BOX', lot: 'LOT', hrs: 'HRS', hour: 'HRS' };
function irpUnit(value) { return UOM[clean(value, 20).toLowerCase()] || 'OTH'; }

function validateEinvoice(invoice, org, customer) {
  const errors = [];
  if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(clean(org.gstin, 15).toUpperCase())) errors.push('Company Settings needs a valid organization GSTIN');
  if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(clean(customer.gstin, 15).toUpperCase())) errors.push('Customer needs a valid GSTIN');
  if (!invoice.number || invoice.number.length > 16) errors.push('Invoice number must be 1 to 16 characters for IRP');
  if (!dateForIrp(invoice.date)) errors.push('Invoice date is invalid');
  if (['cancelled', 'credited'].includes(invoice.status)) errors.push('Cancelled or credited invoices cannot be submitted');
  for (const [label, entity] of [['Company', { ...org, address: org.address }], ['Customer', { ...customer, address: customer.billingAddress }]]) {
    const address = irpAddress(entity);
    if (!address.Addr1 || !address.Loc || !/^\d{6}$/.test(String(address.Pin)) || !/^\d{2}$/.test(address.Stcd)) {
      errors.push(`${label} address needs line 1, city, six-digit pincode and state code`);
    }
  }
  (invoice.lines || []).forEach((line, index) => {
    if (!/^\d{4,8}$/.test(clean(line.hsn, 8))) errors.push(`Invoice line ${index + 1} needs a 4 to 8 digit HSN/SAC code`);
    if (!(Number(line.qty) > 0) || Number(line.rate) < 0) errors.push(`Invoice line ${index + 1} has invalid quantity/rate`);
  });
  return [...new Set(errors)];
}

function buildEinvoice(invoice, org, customer) {
  const seller = irpAddress({ ...org, address: org.address });
  const buyer = irpAddress({ ...customer, address: customer.billingAddress });
  const itemList = (invoice.lines || []).map((line, index) => {
    const product = line.productId ? store.findOne('products', item => item.id === line.productId && item.orgId === invoice.orgId) : null;
    const isService = product ? product.type === 'service' : clean(line.hsn, 8).startsWith('99');
    return {
      SlNo: String(index + 1), PrdDesc: clean(line.name, 300), IsServc: isService ? 'Y' : 'N', HsnCd: clean(line.hsn, 8),
      Qty: Number(line.qty), Unit: irpUnit(line.uom), UnitPrice: r2(line.rate), TotAmt: r2(line.gross),
      Discount: r2(line.discount), AssAmt: r2(line.taxableValue), GstRt: r2(line.gstRate),
      IgstAmt: r2(line.igst), CgstAmt: r2(line.cgst), SgstAmt: r2(line.sgst),
      TotItemVal: r2(line.lineTotal)
    };
  });
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', EcmGstin: null, IgstOnIntra: 'N' },
    DocDtls: { Typ: 'INV', No: invoice.number, Dt: dateForIrp(invoice.date) },
    SellerDtls: { Gstin: clean(org.gstin, 15).toUpperCase(), LglNm: clean(org.legalName || org.name, 100), TrdNm: clean(org.name, 100), ...seller },
    BuyerDtls: { Gstin: clean(customer.gstin, 15).toUpperCase(), LglNm: clean(customer.name, 100), TrdNm: clean(customer.name, 100), Pos: clean(invoice.placeOfSupply || customer.stateCode, 2), ...buyer },
    ItemList: itemList,
    ValDtls: {
      AssVal: r2(invoice.totals.taxable), CgstVal: r2(invoice.totals.cgst), SgstVal: r2(invoice.totals.sgst),
      IgstVal: r2(invoice.totals.igst), Discount: r2(invoice.totals.discountTotal), OthChrg: 0,
      RndOffAmt: r2(invoice.totals.roundOff), TotInvVal: r2(invoice.totals.grandTotal)
    }
  };
}

function existingSubmission(orgId, type, invoiceId, key) {
  return store.findOne('gstSubmissions', item => item.orgId === orgId && item.type === type && item.invoiceId === invoiceId && item.idempotencyKey === key);
}

router.post('/gst/einvoice/:invoiceId', requireGstAction, async (req, res) => {
  const invoice = store.findOne('invoices', item => item.id === req.params.invoiceId && item.orgId === req.org.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const customer = store.findOne('customers', item => item.id === invoice.customerId && item.orgId === req.org.id);
  if (!customer) return res.status(400).json({ error: 'Invoice customer no longer exists' });
  if (invoice.gstEinvoice?.irn) return res.json({ submission: invoice.gstEinvoice, duplicate: true });
  const errors = validateEinvoice(invoice, req.org, customer);
  if (errors.length) return res.status(400).json({ error: 'GST e-Invoice validation failed', code: 'GST_VALIDATION_ERROR', details: errors });
  const payload = buildEinvoice(invoice, req.org, customer);
  const key = idempotencyKey(req, 'gst', `einvoice:${invoice.id}`);
  const previous = existingSubmission(req.org.id, 'einvoice', invoice.id, key);
  if (previous) return res.json({ submission: previous, duplicate: true });
  const submission = store.insert('gstSubmissions', {
    orgId: req.org.id, type: 'einvoice', invoiceId: invoice.id, invoiceNumber: invoice.number,
    provider: 'sandbox', idempotencyKey: key, payloadHash: providers.payloadHash(payload), status: 'submitting', requestedBy: req.user.id
  });
  try {
    const result = await providers.generateEinvoice(req.org.id, req.org.gstin, payload);
    const updated = store.update('gstSubmissions', submission.id, { ...result, acceptedAt: now() });
    store.update('invoices', invoice.id, { gstEinvoice: { ...result, submissionId: updated.id } });
    audit(req.org.id, req.user.id, 'generate', 'gst_einvoice', updated.id, { invoiceNumber: invoice.number, irn: result.irn });
    res.status(201).json({ submission: updated, duplicate: false });
  } catch (error) {
    providers.markProvider(req.org.id, 'gst', false, error.message);
    store.update('gstSubmissions', submission.id, { status: 'failed', failedAt: now(), errorCode: error.code, error: clean(error.message, 300) });
    nextProviderError(error, res);
  }
});

router.post('/gst/ewaybill/:invoiceId', requireGstAction, async (req, res) => {
  const invoice = store.findOne('invoices', item => item.id === req.params.invoiceId && item.orgId === req.org.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const irn = clean(invoice.gstEinvoice?.irn, 100);
  if (!irn) return res.status(409).json({ error: 'Generate the GST e-Invoice IRN before creating an E-Way Bill' });
  if (invoice.gstEwayBill?.ewayBillNo || invoice.gstEinvoice?.ewayBillNo) return res.json({ submission: invoice.gstEwayBill || invoice.gstEinvoice, duplicate: true });
  const distance = Math.floor(Number(req.body.distance));
  const transMode = clean(req.body.transMode || '1', 1);
  const vehicleNo = clean(req.body.vehicleNo, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!Number.isInteger(distance) || distance < 1 || distance > 4000) return res.status(400).json({ error: 'Distance must be between 1 and 4000 km' });
  if (!['1', '2', '3', '4'].includes(transMode)) return res.status(400).json({ error: 'Transport mode must be Road, Rail, Air or Ship' });
  if (transMode === '1' && !/^[A-Z0-9]{7,15}$/.test(vehicleNo)) return res.status(400).json({ error: 'A valid vehicle number is required for road transport' });
  const payload = {
    Distance: distance, TransMode: transMode,
    TransId: clean(req.body.transporterId, 15).toUpperCase() || null,
    TransName: clean(req.body.transporterName, 100) || null,
    TrnDocDt: dateForIrp(req.body.transportDocumentDate) || null,
    TrnDocNo: clean(req.body.transportDocumentNo, 15) || null,
    VehNo: vehicleNo || null, VehType: req.body.vehicleType === 'O' ? 'O' : 'R'
  };
  const key = idempotencyKey(req, 'gst', `ewaybill:${invoice.id}`);
  const previous = existingSubmission(req.org.id, 'ewaybill', invoice.id, key);
  if (previous) return res.json({ submission: previous, duplicate: true });
  const submission = store.insert('gstSubmissions', {
    orgId: req.org.id, type: 'ewaybill', invoiceId: invoice.id, invoiceNumber: invoice.number,
    provider: 'sandbox', idempotencyKey: key, payloadHash: providers.payloadHash(payload), status: 'submitting', requestedBy: req.user.id
  });
  try {
    const result = await providers.generateEwayBill(req.org.id, req.org.gstin, irn, payload);
    const updated = store.update('gstSubmissions', submission.id, { ...result, acceptedAt: now() });
    store.update('invoices', invoice.id, { gstEwayBill: { ...result, submissionId: updated.id } });
    audit(req.org.id, req.user.id, 'generate', 'gst_ewaybill', updated.id, { invoiceNumber: invoice.number, ewayBillNo: result.ewayBillNo });
    res.status(201).json({ submission: updated, duplicate: false });
  } catch (error) {
    providers.markProvider(req.org.id, 'gst', false, error.message);
    store.update('gstSubmissions', submission.id, { status: 'failed', failedAt: now(), errorCode: error.code, error: clean(error.message, 300) });
    nextProviderError(error, res);
  }
});

router.get('/gst/submissions', requireAdminView, (req, res) => {
  const submissions = store.find('gstSubmissions', item => item.orgId === req.org.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(200, Number(req.query.limit) || 100));
  res.json({ submissions });
});

function nextProviderError(error, res) {
  const status = Number(error.status) || 502;
  res.status(status).json({ error: clean(error.message || 'Provider request failed', 300), code: error.code || 'PROVIDER_ERROR' });
}

module.exports = router;
