/**
 * Production provider adapters for Tech Defenders OS.
 *
 * Secrets are read only from process.env. Provider responses written to the
 * JSON store are deliberately reduced to operational identifiers/statuses.
 */
'use strict';
const crypto = require('crypto');
const store = require('../../db/store');

const PROVIDERS = [
  {
    key: 'email', label: 'Email · Brevo Free Tier', mark: 'BR',
    credentials: ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL'],
    description: 'Transactional OTPs, invoices, quotations and service updates',
    setup: 'Create a Brevo account, verify a sender/domain, then add the free-tier API key and sender address in Render. Current Brevo quota rules still apply.'
  },
  {
    key: 'sms', label: 'SMS · MSG91', mark: 'M9',
    credentials: ['MSG91_AUTH_KEY'],
    description: 'India DLT-compliant automated messages through MSG91 Flow (paid credits/DLT may apply)',
    setup: 'Complete DLT registration, approve a sender ID and Flow template, then add the auth key in Render.'
  },
  {
    key: 'whatsapp', label: 'WhatsApp · Meta Cloud API', mark: 'WA',
    credentials: ['META_WHATSAPP_TOKEN', 'META_PHONE_NUMBER_ID'],
    description: 'Approved WhatsApp Business template notifications (Meta pricing may apply)',
    setup: 'Connect a Meta Business phone number, approve templates and add a permanent system-user token.'
  },
  {
    key: 'gst', label: 'GST · Sandbox GSP', mark: 'GST',
    credentials: ['SANDBOX_API_KEY', 'SANDBOX_API_SECRET', 'SANDBOX_EINVOICE_USERNAME', 'SANDBOX_EINVOICE_PASSWORD'],
    description: 'IRN, signed QR code and E-Way Bill submission through a GST API provider',
    setup: 'Create Sandbox credentials and map the GST portal e-Invoice API user to the selected GSP.'
  }
];

class ProviderError extends Error {
  constructor(message, code, status, retryable) {
    super(message);
    this.name = 'ProviderError';
    this.code = code || 'PROVIDER_ERROR';
    this.status = status || 502;
    this.retryable = !!retryable;
    this.expose = true;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = (value, max = 500) => String(value == null ? '' : value).trim().slice(0, max);
const digits = value => clean(value, 30).replace(/\D/g, '');
const maskRecipient = value => {
  const text = clean(value, 180);
  if (text.includes('@')) {
    const [local, domain] = text.split('@');
    return `${local.slice(0, 2)}***@${domain || ''}`;
  }
  const number = digits(text);
  return number.length > 4 ? `***${number.slice(-4)}` : '***';
};

function definition(key) {
  return PROVIDERS.find(item => item.key === key) || null;
}

function missingCredentials(provider) {
  return provider.credentials.filter(key => !clean(process.env[key]));
}

function providerState(orgId, providerOrKey) {
  const provider = typeof providerOrKey === 'string' ? definition(providerOrKey) : providerOrKey;
  if (!provider) return null;
  const config = store.findOne('integrationConfigs', item => item.orgId === orgId && item.provider === provider.key);
  const missing = missingCredentials(provider);
  const enabled = !!(config && config.enabled);
  const configured = enabled && missing.length === 0;
  const active = configured && !!config.lastSuccessAt;
  return {
    provider: provider.key,
    label: provider.label,
    mark: provider.mark,
    description: provider.description,
    setup: provider.setup,
    enabled,
    configured,
    active,
    status: !enabled ? 'disabled' : (missing.length ? 'missing_credentials' : (active ? 'active' : 'configured_not_verified')),
    requiredEnvironment: provider.credentials,
    missingEnvironment: missing,
    lastCheckedAt: config ? config.lastCheckedAt || null : null,
    lastSuccessAt: config ? config.lastSuccessAt || null : null,
    lastErrorAt: config ? config.lastErrorAt || null : null,
    message: !enabled ? 'Disabled by administrator'
      : (missing.length ? `Missing server configuration: ${missing.join(', ')}`
        : (active ? 'Provider has completed a successful live request' : 'Credentials found; run a live verification'))
  };
}

function setProviderEnabled(orgId, providerKey, enabled, actorUserId) {
  const provider = definition(providerKey);
  if (!provider) throw new ProviderError('Unknown provider', 'UNKNOWN_PROVIDER', 404);
  let config = store.findOne('integrationConfigs', item => item.orgId === orgId && item.provider === provider.key);
  const patch = { enabled: !!enabled, lastCheckedAt: new Date().toISOString(), updatedBy: actorUserId };
  config = config
    ? store.update('integrationConfigs', config.id, patch)
    : store.insert('integrationConfigs', { orgId, provider: provider.key, ...patch });
  return { config, state: providerState(orgId, provider) };
}

function markProvider(orgId, key, success, errorMessage) {
  let config = store.findOne('integrationConfigs', item => item.orgId === orgId && item.provider === key);
  const now = new Date().toISOString();
  const patch = success
    ? { lastCheckedAt: now, lastSuccessAt: now, lastErrorAt: null, lastError: null }
    : { lastCheckedAt: now, lastErrorAt: now, lastError: clean(errorMessage, 300) };
  config = config
    ? store.update('integrationConfigs', config.id, patch)
    : store.insert('integrationConfigs', { orgId, provider: key, enabled: false, ...patch });
  return config;
}

function requireConfigured(orgId, key) {
  const state = providerState(orgId, key);
  if (!state) throw new ProviderError('Unknown provider', 'UNKNOWN_PROVIDER', 404);
  if (!state.enabled) throw new ProviderError(`${state.label} is disabled`, 'PROVIDER_DISABLED', 409);
  if (!state.configured) throw new ProviderError(state.message, 'PROVIDER_NOT_CONFIGURED', 503);
  return state;
}

function providerBase(name, official) {
  const override = process.env[`TD_TEST_${name.toUpperCase()}_BASE_URL`];
  if (!override) return official;
  if (process.env.NODE_ENV !== 'test') return official;
  let parsed;
  try { parsed = new URL(override); } catch (_) { return official; }
  return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    ? parsed.origin : official;
}

function providerMessage(body, fallback) {
  if (!body || typeof body !== 'object') return fallback;
  const direct = body.message || body.error || body.errorMessage;
  if (typeof direct === 'string') return clean(direct, 300);
  if (direct && typeof direct.message === 'string') return clean(direct.message, 300);
  const details = body.data && (body.data.ErrorDetails || body.data.error);
  if (Array.isArray(details) && details[0]) return clean(details[0].ErrorMessage || details[0].message, 300);
  if (details && typeof details === 'object') return clean(details.ErrorMessage || details.message, 300);
  return fallback;
}

async function requestJson(url, options = {}) {
  const attempts = options.retry === false ? 1 : 3;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.PROVIDER_TIMEOUT_MS) || 15_000);
    try {
      const response = await fetch(url, { ...options, retry: undefined, signal: controller.signal });
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = { raw: clean(raw, 1000) }; }
      if (response.ok) return { status: response.status, body, headers: response.headers };
      const retryable = response.status === 429 || response.status >= 500;
      lastError = new ProviderError(providerMessage(body, `Provider returned HTTP ${response.status}`), 'PROVIDER_HTTP_ERROR', 502, retryable);
      if (!retryable || attempt === attempts - 1) throw lastError;
    } catch (error) {
      if (error instanceof ProviderError) {
        lastError = error;
        if (!error.retryable || attempt === attempts - 1) throw error;
      } else {
        lastError = new ProviderError(error.name === 'AbortError' ? 'Provider request timed out' : 'Provider connection failed', 'PROVIDER_UNAVAILABLE', 503, true);
        if (attempt === attempts - 1) throw lastError;
      }
    } finally {
      clearTimeout(timeout);
    }
    await sleep(150 * (attempt + 1));
  }
  throw lastError;
}

function emailValid(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value, 180));
}

async function sendEmail(input) {
  requireConfigured(input.orgId, 'email');
  const result = await sendBrevoEmail(input);
  markProvider(input.orgId, 'email', true);
  return result;
}

async function sendBrevoEmail(input) {
  const missing = ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL'].filter(key => !clean(process.env[key]));
  if (missing.length) throw new ProviderError(`Email OTP is not configured. Missing server configuration: ${missing.join(', ')}`, 'EMAIL_OTP_NOT_CONFIGURED', 503);
  if (!emailValid(input.to)) throw new ProviderError('A valid recipient email is required', 'VALIDATION_ERROR', 400);
  const subject = clean(input.subject, 180);
  const textContent = clean(input.text, 20_000);
  const htmlContent = clean(input.html, 50_000);
  if (!subject || (!textContent && !htmlContent)) throw new ProviderError('Subject and message content are required', 'VALIDATION_ERROR', 400);
  const payload = {
    sender: { email: clean(process.env.BREVO_SENDER_EMAIL, 180), name: clean(process.env.BREVO_SENDER_NAME || 'Tech Defenders', 100) },
    to: [{ email: clean(input.to, 180), name: clean(input.name, 100) }],
    subject,
    tags: ['tech-defenders-os']
  };
  if (htmlContent) payload.htmlContent = htmlContent;
  else payload.textContent = textContent;
  const attachments = (Array.isArray(input.attachments) ? input.attachments : []).slice(0, 5)
    .filter(item => item && /^[a-z0-9][a-z0-9._ -]{0,119}$/i.test(clean(item.name, 120)) && /^[A-Za-z0-9+/=]+$/.test(clean(item.content, 8_000_000)));
  if (attachments.length) payload.attachment = attachments.map(item => ({ name: clean(item.name, 120), content: clean(item.content, 8_000_000) }));
  const result = await requestJson(providerBase('brevo', 'https://api.brevo.com') + '/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify(payload)
  });
  const providerId = clean(result.body.messageId, 300);
  if (!providerId) throw new ProviderError('Brevo accepted no message identifier', 'INVALID_PROVIDER_RESPONSE', 502);
  return { provider: 'brevo', providerId, status: 'accepted', recipient: maskRecipient(input.to) };
}

/** Public-auth transactional email. It intentionally does not depend on an
 * organization integration switch because a new workspace has no org yet. */
async function sendSystemEmail(input) {
  return sendBrevoEmail({ ...input, name: input.name || 'Tech Defenders user' });
}

function normalizeMobile(value) {
  let number = digits(value);
  if (number.length === 10) number = '91' + number;
  if (number.length < 11 || number.length > 15) throw new ProviderError('Use a valid mobile number with country code', 'VALIDATION_ERROR', 400);
  return number;
}

async function sendSms(input) {
  requireConfigured(input.orgId, 'sms');
  const mobile = normalizeMobile(input.to);
  const templateId = clean(input.templateId || process.env.MSG91_DEFAULT_TEMPLATE_ID, 120);
  if (!templateId) throw new ProviderError('An approved MSG91 Flow template ID is required', 'VALIDATION_ERROR', 400);
  const variables = input.variables && typeof input.variables === 'object' ? input.variables : {};
  const recipient = { mobiles: mobile };
  for (const [key, value] of Object.entries(variables).slice(0, 20)) {
    if (/^[A-Z0-9_]{1,30}$/i.test(key)) recipient[key] = clean(value, 300);
  }
  const result = await requestJson(providerBase('msg91', 'https://control.msg91.com') + '/api/v5/flow/', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authkey: process.env.MSG91_AUTH_KEY },
    body: JSON.stringify({ template_id: templateId, short_url: '0', recipients: [recipient] })
  });
  const providerId = clean(result.body.request_id || result.body.requestId || result.body.message, 300);
  if (!providerId || String(result.body.type || '').toLowerCase() === 'error') {
    throw new ProviderError(providerMessage(result.body, 'MSG91 rejected the message'), 'INVALID_PROVIDER_RESPONSE', 502);
  }
  markProvider(input.orgId, 'sms', true);
  return { provider: 'msg91', providerId, status: 'accepted', recipient: maskRecipient(mobile) };
}

async function sendWhatsApp(input) {
  requireConfigured(input.orgId, 'whatsapp');
  const mobile = normalizeMobile(input.to);
  const templateName = clean(input.templateName || process.env.META_DEFAULT_TEMPLATE, 512);
  const language = clean(input.language || process.env.META_DEFAULT_LANGUAGE || 'en_US', 20);
  if (!templateName) throw new ProviderError('An approved WhatsApp template name is required', 'VALIDATION_ERROR', 400);
  const parameters = (Array.isArray(input.parameters) ? input.parameters : []).slice(0, 20)
    .map(value => ({ type: 'text', text: clean(value, 1000) }));
  const template = { name: templateName, language: { code: language } };
  if (parameters.length) template.components = [{ type: 'body', parameters }];
  const version = clean(process.env.META_GRAPH_VERSION || 'v23.0', 20);
  const path = `/${version}/${encodeURIComponent(process.env.META_PHONE_NUMBER_ID)}/messages`;
  const result = await requestJson(providerBase('meta', 'https://graph.facebook.com') + path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${process.env.META_WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: mobile, type: 'template', template })
  });
  const providerId = clean(result.body.messages && result.body.messages[0] && result.body.messages[0].id, 300);
  if (!providerId) throw new ProviderError(providerMessage(result.body, 'Meta accepted no WhatsApp message identifier'), 'INVALID_PROVIDER_RESPONSE', 502);
  markProvider(input.orgId, 'whatsapp', true);
  return { provider: 'meta', providerId, status: 'accepted', recipient: maskRecipient(mobile) };
}

const gstTokens = new Map();
function gstSuccessData(response) {
  const outer = response && response.data ? response.data : response;
  if (!outer || (outer.Status !== undefined && Number(outer.Status) !== 1)) {
    throw new ProviderError(providerMessage(response, 'GST provider rejected the request'), 'GST_PROVIDER_REJECTED', 422);
  }
  return outer.Data || outer;
}

async function gstAuthenticate(orgId, gstin, force) {
  requireConfigured(orgId, 'gst');
  const normalizedGstin = clean(gstin || process.env.SANDBOX_GSTIN, 15).toUpperCase();
  if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(normalizedGstin)) throw new ProviderError('A valid 15-character organization GSTIN is required', 'GST_VALIDATION_ERROR', 400);
  const cached = gstTokens.get(normalizedGstin);
  if (!force && cached && cached.expiresAt > Date.now() + 10 * 60_000) return { gstin: normalizedGstin, cached: true, token: cached.token };
  const root = providerBase('sandbox', 'https://api.sandbox.co.in');
  const sandboxResult = await requestJson(root + '/authenticate', {
    method: 'POST', retry: false,
    headers: { accept: 'application/json', 'x-api-key': process.env.SANDBOX_API_KEY, 'x-api-secret': process.env.SANDBOX_API_SECRET, 'x-api-version': '1.0.0' }
  });
  const sandboxToken = clean((sandboxResult.body.data && sandboxResult.body.data.access_token) || sandboxResult.body.access_token, 5000);
  if (!sandboxToken) throw new ProviderError('Sandbox authentication returned no access token', 'GST_AUTH_FAILED', 502);
  const irpResult = await requestJson(root + '/gst/compliance/e-invoice/tax-payer/authenticate?force=true', {
    method: 'POST', retry: false,
    headers: { authorization: sandboxToken, 'x-api-key': process.env.SANDBOX_API_KEY, 'x-api-version': '1.0.0', 'x-source': process.env.SANDBOX_IRP_SOURCE || 'primary', 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.SANDBOX_EINVOICE_USERNAME, password: process.env.SANDBOX_EINVOICE_PASSWORD, gstin: normalizedGstin })
  });
  const data = gstSuccessData(irpResult.body);
  const token = clean(data.access_token, 5000);
  if (!token) throw new ProviderError('IRP authentication returned no access token', 'GST_AUTH_FAILED', 502);
  const expiry = Number(data.expiry);
  gstTokens.set(normalizedGstin, { token, expiresAt: expiry > Date.now() ? expiry : Date.now() + 5 * 60 * 60_000 });
  markProvider(orgId, 'gst', true);
  return { gstin: normalizedGstin, cached: false, token };
}

function gstHeaders(token) {
  return {
    authorization: token,
    'x-api-key': process.env.SANDBOX_API_KEY,
    'x-api-version': '1.0.0',
    'x-source': process.env.SANDBOX_IRP_SOURCE || 'primary',
    'content-type': 'application/json'
  };
}

async function generateEinvoice(orgId, gstin, payload) {
  const session = await gstAuthenticate(orgId, gstin, false);
  const root = providerBase('sandbox', 'https://api.sandbox.co.in');
  const result = await requestJson(root + '/gst/compliance/e-invoice/tax-payer/invoice', {
    method: 'POST', retry: false, headers: gstHeaders(session.token), body: JSON.stringify(payload)
  });
  const data = gstSuccessData(result.body);
  if (!clean(data.Irn)) throw new ProviderError('IRP response did not contain an IRN', 'INVALID_PROVIDER_RESPONSE', 502);
  markProvider(orgId, 'gst', true);
  return {
    irn: clean(data.Irn, 100), ackNo: clean(data.AckNo, 100), ackDate: clean(data.AckDt, 80),
    signedInvoice: clean(data.SignedInvoice, 500_000), signedQrCode: clean(data.SignedQRCode, 500_000),
    ewayBillNo: clean(data.EwbNo, 100), ewayBillDate: clean(data.EwbDt, 80), ewayBillValidTill: clean(data.EwbValidTill, 80),
    transactionId: clean(result.body.transaction_id, 120), status: 'generated'
  };
}

async function generateEwayBill(orgId, gstin, irn, payload) {
  const session = await gstAuthenticate(orgId, gstin, false);
  const root = providerBase('sandbox', 'https://api.sandbox.co.in');
  const result = await requestJson(root + `/gst/compliance/e-invoice/tax-payer/invoice/${encodeURIComponent(irn)}/e-way-bill`, {
    method: 'POST', retry: false, headers: gstHeaders(session.token), body: JSON.stringify({ Irn: irn, ...payload })
  });
  const data = gstSuccessData(result.body);
  if (!clean(data.EwbNo)) throw new ProviderError('GST response did not contain an E-Way Bill number', 'INVALID_PROVIDER_RESPONSE', 502);
  markProvider(orgId, 'gst', true);
  return {
    ewayBillNo: clean(data.EwbNo, 100), ewayBillDate: clean(data.EwbDt, 80),
    ewayBillValidTill: clean(data.EwbValidTill, 80), transactionId: clean(result.body.transaction_id, 120), status: 'generated'
  };
}

function payloadHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

module.exports = {
  PROVIDERS, ProviderError, definition, providerState, setProviderEnabled, markProvider,
  requireConfigured, requestJson, sendEmail, sendSystemEmail, sendSms, sendWhatsApp, gstAuthenticate,
  generateEinvoice, generateEwayBill, maskRecipient, payloadHash, clean, normalizeMobile
};
