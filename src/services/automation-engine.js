'use strict';

const crypto = require('crypto');
const store = require('../../db/store');
const providers = require('./integrations');
const communications = require('./communications');
const { notify, audit, stockBalance } = require('../util');

let running = false;
const clean = (value, max = 500) => String(value == null ? '' : value).trim().slice(0, max);
const today = () => new Date().toISOString().slice(0, 10);

const TRIGGERS = [
  'new_lead', 'new_customer', 'new_invoice', 'invoice_due', 'invoice_overdue', 'payment_received',
  'quotation_created', 'quotation_accepted', 'amc_expiring', 'ticket_created', 'ticket_closed', 'low_stock', 'new_sale', 'lead_stale'
];
const ACTIONS = ['send_email', 'send_whatsapp', 'create_task', 'notify_user', 'update_status', 'create_reminder', 'generate_report'];
const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'];

function getPath(source, path) {
  return String(path || '').split('.').filter(Boolean).reduce((value, key) => value == null ? undefined : value[key], source);
}

function compare(actual, operator, expected) {
  if (['gt', 'gte', 'lt', 'lte'].includes(operator)) {
    const a = Number(actual), b = Number(expected);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return operator === 'gt' ? a > b : operator === 'gte' ? a >= b : operator === 'lt' ? a < b : a <= b;
  }
  if (operator === 'contains') return String(actual || '').toLowerCase().includes(String(expected || '').toLowerCase());
  if (operator === 'neq') return String(actual ?? '') !== String(expected ?? '');
  return String(actual ?? '') === String(expected ?? '');
}

function conditionsPass(record, conditions) {
  return (conditions || []).every(condition => compare(getPath(record, condition.field), condition.operator, condition.value));
}

function triggerRecords(rule) {
  const orgId = rule.orgId, now = new Date(), date = today();
  const recent = record => !rule.lastEvaluatedAt || new Date(record.createdAt) > new Date(rule.lastEvaluatedAt);
  if (rule.trigger === 'low_stock') return store.find('products', product => product.orgId === orgId && product.type !== 'service').map(product => ({ ...product, currentStock: stockBalance(orgId, product.id), minimumStock: Number(product.minStock) || 0 })).filter(product => product.currentStock < product.minimumStock);
  if (rule.trigger === 'invoice_overdue') return store.find('invoices', item => item.orgId === orgId && !['paid', 'cancelled', 'credited'].includes(item.status) && item.dueDate && item.dueDate < date).map(item => ({ ...item, balanceDue: Number(item.totals?.grandTotal || 0) - Number(item.paidAmount || 0) }));
  if (rule.trigger === 'invoice_due') { const days = Number(rule.triggerConfig?.daysBefore) || 3; const due = new Date(now); due.setUTCDate(due.getUTCDate() + days); const dueDate = due.toISOString().slice(0, 10); return store.find('invoices', item => item.orgId === orgId && !['paid', 'cancelled', 'credited'].includes(item.status) && item.dueDate === dueDate); }
  if (rule.trigger === 'amc_expiring') { const days = Number(rule.triggerConfig?.daysBefore) || 30; const due = new Date(now); due.setUTCDate(due.getUTCDate() + days); return store.find('amcContracts', item => item.orgId === orgId && item.status === 'active' && item.endDate === due.toISOString().slice(0, 10)); }
  if (rule.trigger === 'lead_stale') { const days = Number(rule.triggerConfig?.daysInactive) || 3; const cutoff = Date.now() - days * 86400000; return store.find('leads', item => item.orgId === orgId && !['converted', 'lost'].includes(item.status) && new Date(item.updatedAt || item.createdAt).getTime() < cutoff); }
  const map = {
    new_lead: ['leads'], new_customer: ['customers'], new_invoice: ['invoices'], payment_received: ['receipts'],
    quotation_created: ['quotations'], quotation_accepted: ['quotations', item => item.status === 'accepted'],
    ticket_created: ['tickets'], ticket_closed: ['tickets', item => item.status === 'closed'], new_sale: ['invoices']
  };
  const target = map[rule.trigger];
  if (!target) return [];
  return store.find(target[0], item => item.orgId === orgId && recent(item) && (!target[1] || target[1](item)));
}

function fingerprint(rule, record) {
  const period = ['low_stock', 'invoice_overdue', 'invoice_due', 'amc_expiring', 'lead_stale'].includes(rule.trigger) ? today() : record.createdAt;
  return crypto.createHash('sha256').update(`${rule.id}:${record.id}:${period}`).digest('hex');
}

function customerFor(record) {
  return record.customerId ? store.findOne('customers', item => item.id === record.customerId && item.orgId === record.orgId) : null;
}

function actionVariables(rule, record, customer, org) {
  const invoice = rule.trigger.includes('invoice') || rule.trigger === 'new_sale' ? record : null;
  return communications.variablesFor(org, customer, { invoice, salesPerson: '' });
}

async function executeAction(execution, action, record, rule) {
  const org = store.byId('organizations', rule.orgId);
  const customer = customerFor(record);
  const variables = actionVariables(rule, record, customer, org || {});
  if (action.type === 'notify_user') {
    notify(rule.orgId, { userId: action.userId || null, title: communications.renderTemplate(action.title || rule.name, variables), body: communications.renderTemplate(action.message || `Automation matched ${rule.trigger}`, variables), type: action.tone || 'info', link: action.link || null });
    return { status: 'completed' };
  }
  if (action.type === 'create_task' || action.type === 'create_reminder') {
    const due = new Date(); due.setUTCDate(due.getUTCDate() + (Number(action.dueInDays) || 1));
    const task = store.insert('tasks', { orgId: rule.orgId, title: communications.renderTemplate(action.title || `Follow up: ${rule.name}`, variables), description: communications.renderTemplate(action.message || '', variables), dueDate: due.toISOString().slice(0, 10), priority: action.priority || 'medium', status: 'open', assignee: action.userId || rule.createdBy, relatedType: rule.trigger, relatedId: record.id, automationExecutionId: execution.id });
    return { status: 'completed', taskId: task.id };
  }
  if (action.type === 'update_status') {
    const allowed = { leads: ['new', 'contacted', 'qualified', 'lost'], tickets: ['open', 'assigned', 'in_progress', 'waiting_parts', 'waiting_customer', 'resolved', 'closed'], quotations: ['draft', 'sent', 'accepted', 'rejected', 'expired'] };
    const collection = action.collection;
    if (!allowed[collection]?.includes(action.status)) throw new Error('Automation status update is not allowed');
    const target = store.findOne(collection, item => item.id === record.id && item.orgId === rule.orgId);
    if (!target) throw new Error('Automation status target not found');
    store.update(collection, target.id, { status: action.status });
    return { status: 'completed' };
  }
  if (action.type === 'send_email') {
    if (!customer?.email) throw new Error('Customer email is missing');
    const campaign = communications.queueEmail(org, { id: rule.createdBy }, { to: customer.email, name: customer.name, subject: communications.renderTemplate(action.subject || rule.name, variables), body: communications.renderTemplate(action.message || '', variables), type: 'transactional', invoiceId: record.customerId && record.number ? record.id : null, attachInvoice: action.attachInvoice === true });
    return { status: 'queued', campaignId: campaign.id };
  }
  if (action.type === 'send_whatsapp') {
    if (!customer?.phone) throw new Error('Customer mobile number is missing');
    const result = await providers.sendWhatsApp({ orgId: rule.orgId, to: customer.phone, templateName: action.templateName, language: action.language || 'en_US', parameters: (action.parameters || []).map(value => communications.renderTemplate(value, variables)) });
    const delivery = store.insert('messageDeliveries', { orgId: rule.orgId, channel: 'whatsapp', idempotencyKey: `${execution.id}:${action.type}`, recipient: result.recipient, reference: rule.name, status: result.status, provider: result.provider, providerId: result.providerId, requestedBy: rule.createdBy, attemptCount: 1, acceptedAt: new Date().toISOString() });
    store.insert('communicationLogs', { orgId: rule.orgId, customerId: customer.id, channel: 'whatsapp', messageType: rule.trigger, relatedInvoiceId: record.number && record.totals ? record.id : null, status: result.status, initiatedBy: rule.createdBy, automationExecutionId: execution.id, deliveryId: delivery.id });
    return { status: 'completed', providerId: result.providerId };
  }
  if (action.type === 'generate_report') {
    const report = store.insert('savedReports', { orgId: rule.orgId, name: `${rule.name} · ${today()}`, type: action.reportType || 'automation', parameters: { trigger: rule.trigger, recordId: record.id }, generatedByAutomation: true });
    return { status: 'completed', reportId: report.id };
  }
  throw new Error(`Unsupported automation action: ${action.type}`);
}

function evaluateRule(rule, actorUserId) {
  if (!rule.enabled) return { matched: 0, queued: 0 };
  const records = triggerRecords(rule).filter(record => conditionsPass(record, rule.conditions));
  let queued = 0;
  for (const record of records) {
    const key = fingerprint(rule, record);
    if (store.findOne('automationExecutions', item => item.orgId === rule.orgId && item.idempotencyKey === key)) continue;
    const scheduledAt = new Date(Date.now() + (Number(rule.delayMinutes) || 0) * 60000).toISOString();
    store.insert('automationExecutions', { orgId: rule.orgId, ruleId: rule.id, trigger: rule.trigger, recordId: record.id, recordSnapshot: record, idempotencyKey: key, status: 'queued', scheduledAt, attempts: 0, maxAttempts: 3, initiatedBy: actorUserId || rule.createdBy });
    queued += 1;
  }
  store.update('automationRules', rule.id, { lastEvaluatedAt: new Date().toISOString(), lastMatched: records.length, lastQueued: queued });
  return { matched: records.length, queued };
}

async function processExecution(execution) {
  const rule = store.findOne('automationRules', item => item.id === execution.ruleId && item.orgId === execution.orgId);
  if (!rule || !rule.enabled) throw new Error('Automation rule is disabled or missing');
  const results = [];
  for (const action of rule.actions || []) results.push({ type: action.type, ...(await executeAction(execution, action, execution.recordSnapshot, rule)) });
  store.update('automationExecutions', execution.id, { status: 'completed', completedAt: new Date().toISOString(), results, attempts: execution.attempts + 1 });
  audit(rule.orgId, execution.initiatedBy, 'automation_executed', 'automation_rule', rule.id, { executionId: execution.id, trigger: rule.trigger, actions: results.length });
}

async function runAutomationWorker() {
  if (running) return;
  running = true;
  try {
    for (const rule of store.find('automationRules', item => item.enabled && item.engineVersion === 2)) evaluateRule(rule);
    const due = store.find('automationExecutions', item => ['queued', 'retry'].includes(item.status) && new Date(item.nextAttemptAt || item.scheduledAt) <= new Date()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 25);
    for (const execution of due) {
      store.update('automationExecutions', execution.id, { status: 'running', attempts: execution.attempts + 1, startedAt: new Date().toISOString() });
      try { await processExecution(execution); }
      catch (error) {
        const current = store.byId('automationExecutions', execution.id) || execution;
        const retry = current.attempts < current.maxAttempts;
        store.update('automationExecutions', execution.id, { status: retry ? 'retry' : 'failed', error: clean(error.message, 300), nextAttemptAt: retry ? new Date(Date.now() + Math.pow(2, current.attempts) * 60000).toISOString() : null, failedAt: retry ? null : new Date().toISOString() });
      }
    }
  } finally { running = false; }
}

function validateRule(input) {
  if (!clean(input.name, 160)) throw new Error('Automation name is required');
  if (!TRIGGERS.includes(input.trigger)) throw new Error('Select a supported automation trigger');
  const conditions = Array.isArray(input.conditions) ? input.conditions.slice(0, 10) : [];
  if (conditions.some(item => !clean(item.field, 80) || !OPERATORS.includes(item.operator))) throw new Error('A condition is invalid');
  const actions = Array.isArray(input.actions) ? input.actions.slice(0, 10) : [];
  if (!actions.length || actions.some(item => !ACTIONS.includes(item.type))) throw new Error('Add at least one supported action');
  return { name: clean(input.name, 160), description: clean(input.description, 500), trigger: input.trigger, triggerConfig: input.triggerConfig || {}, conditions, actions, delayMinutes: Math.min(43200, Math.max(0, Number(input.delayMinutes) || 0)), schedule: clean(input.schedule || 'every_15_minutes', 80), enabled: input.enabled !== false, engineVersion: 2 };
}

module.exports = { TRIGGERS, ACTIONS, OPERATORS, compare, conditionsPass, validateRule, evaluateRule, runAutomationWorker };
