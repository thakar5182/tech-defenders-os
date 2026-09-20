/**
 * Shared server utilities: money math, GST engine, document numbering,
 * audit trail, notifications and the role/permission matrix.
 */
'use strict';
const crypto = require('crypto');
const store = require('../db/store');

/* ---------------- money / rounding ---------------- */
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ---------------- financial year (Apr-Mar) ---------------- */
function fyOf(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1-12
  const startYear = m >= 4 ? y : y - 1;
  return String(startYear % 100).padStart(2, '0') + String((startYear + 1) % 100).padStart(2, '0');
}

/* ---------------- document numbering ---------------- */
const SEQ_PREFIX = {
  quotation: 'QTN', salesOrder: 'SO', invoice: 'INV', receipt: 'RCP', creditNote: 'CN',
  requisition: 'PRQ', rfq: 'RFQ', purchaseOrder: 'PO', grn: 'GRN',
  jobOrder: 'JO', ticket: 'TKT', amc: 'AMC', journal: 'JV', expense: 'EXP',
  proforma: 'PI', deliveryChallan: 'DC', debitNote: 'DN', purchaseInvoice: 'PINV',
  purchaseReturn: 'PRTN', supplierPayment: 'SPAY', reservation: 'RSV',
  approval: 'APR', bankTransaction: 'BTX'
  , importJob: 'IMP', emailCampaign: 'EMC', automationExecution: 'AEX'
};
function nextNumber(orgId, type) {
  const prefix = SEQ_PREFIX[type] || type.toUpperCase().slice(0, 3);
  let seq = store.findOne('sequences', s => s.orgId === orgId && s.type === type);
  if (!seq) {
    seq = store.insert('sequences', { orgId, type, prefix, nextNumber: 1 });
  }
  const num = seq.nextNumber;
  store.update('sequences', seq.id, { nextNumber: num + 1 });
  return `${prefix}-${fyOf()}-${String(num).padStart(4, '0')}`;
}
function peekNumber(orgId, type) {
  const seq = store.findOne('sequences', s => s.orgId === orgId && s.type === type);
  const prefix = SEQ_PREFIX[type] || type.toUpperCase().slice(0, 3);
  return `${prefix}-${fyOf()}-${String(seq ? seq.nextNumber : 1).padStart(4, '0')}`;
}

/* ---------------- GST engine ----------------
 * Intra-state (company state == place of supply): CGST + SGST at rate/2 each.
 * Inter-state: IGST at full rate.
 * Returns per-line taxable values plus consolidated totals.
 */
function computeDoc(lines, companyStateCode, placeOfSupplyStateCode) {
  let subtotal = 0, discountTotal = 0, taxable = 0, cgst = 0, sgst = 0, igst = 0;
  const intra = String(companyStateCode) === String(placeOfSupplyStateCode);
  const outLines = lines.map(l => {
    const qty = Number(l.qty) || 0;
    const rate = Number(l.rate) || 0;
    const discPct = Number(l.discountPct) || 0;
    const gstRate = Number(l.gstRate) || 0;
    const gross = r2(qty * rate);
    const discount = r2(gross * discPct / 100);
    const lineTaxable = r2(gross - discount);
    const tax = r2(lineTaxable * gstRate / 100);
    subtotal += gross;
    discountTotal += discount;
    taxable += lineTaxable;
    if (intra) { cgst += r2(tax / 2); sgst += r2(tax / 2); }
    else { igst += tax; }
    return Object.assign({}, l, {
      gross, discount, taxableValue: lineTaxable,
      cgst: intra ? r2(tax / 2) : 0,
      sgst: intra ? r2(tax / 2) : 0,
      igst: intra ? 0 : tax,
      lineTotal: r2(lineTaxable + tax)
    });
  });
  const grandTotal = r2(taxable + cgst + sgst + igst);
  return {
    lines: outLines,
    totals: {
      subtotal: r2(subtotal), discountTotal: r2(discountTotal),
      taxable: r2(taxable), cgst: r2(cgst), sgst: r2(sgst), igst: r2(igst),
      grandTotal, roundOff: 0
    },
    intra
  };
}

/* ---------------- audit trail ---------------- */
function audit(orgId, actorUserId, action, entity, entityId, meta) {
  const previous = store.find('auditEvents', event => event.orgId === orgId).slice(-1)[0];
  const payload = {
    orgId, actorUserId: actorUserId || null, action, entity,
    entityId: entityId || null,
    meta: meta && typeof meta === 'object' ? JSON.stringify(meta).slice(0, 2000) : (meta || null),
    previousHash: previous && previous.currentHash ? previous.currentHash : null
  };
  payload.currentHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  store.insert('auditEvents', payload);
}

/* ---------------- notifications ---------------- */
function notify(orgId, opts) {
  // opts: {title, body, type, link, userId(optional - null = all admins/owners)}
  store.insert('notifications', {
    orgId,
    userId: opts.userId || null,
    title: opts.title || 'Notification',
    body: opts.body || '',
    type: opts.type || 'info',           // info | success | warning | danger
    link: opts.link || null,
    read: false
  });
}

/* ---------------- stock ledger helper ---------------- */
function postStock(entry) {
  // entry: {orgId, productId, warehouseId, date, type, qty(+/-), rate, refType, refId, refNumber, note}
  return store.insert('stockLedger', Object.assign({ date: new Date().toISOString().slice(0, 10) }, entry));
}
function stockBalance(orgId, productId, warehouseId) {
  return r2(store.find('stockLedger', e =>
    e.orgId === orgId && e.productId === productId &&
    (!warehouseId || e.warehouseId === warehouseId)
  ).reduce((s, e) => s + (Number(e.qty) || 0), 0));
}

/* ---------------- RBAC matrix ----------------
 * Modules: crm, sales, purchase, inventory, manufacturing, service,
 *          finance, hr, reports, admin
 * Actions: view, create, edit, approve, delete, export
 */
const ROLE_PERMS = {
  super_admin:        { '*': ['*'] },
  admin:              { '*': ['*'] },
  sales_manager:      { crm: ['*'], sales: ['*'], inventory: ['view'], reports: ['view'], service: ['view'], communication: ['*'], automation: ['view'], projects: ['*'], operations: ['view', 'create'] },
  sales_exec:         { crm: ['view', 'create', 'edit'], sales: ['view', 'create', 'edit'], inventory: ['view'], reports: ['view'], communication: ['view', 'create', 'edit'] },
  purchase_manager:   { purchase: ['*'], inventory: ['view', 'create', 'edit'], reports: ['view'] },
  store_manager:      { inventory: ['*'], purchase: ['view', 'edit'], manufacturing: ['view', 'edit'], reports: ['view'] },
  production_manager: { manufacturing: ['*'], inventory: ['view', 'edit'], reports: ['view'] },
  accountant:         { finance: ['*'], sales: ['view', 'edit'], purchase: ['view', 'approve'], reports: ['view'], hr: ['view', 'approve'], communication: ['view', 'create', 'edit'], dataImport: ['view', 'create'] },
  service_manager:    { service: ['*'], inventory: ['view', 'edit'], crm: ['view'], reports: ['view'], communication: ['view', 'create', 'edit'], projects: ['*'], operations: ['*'] },
  engineer:           { service: ['view', 'edit'], inventory: ['view'], projects: ['view', 'create', 'edit'], operations: ['view', 'create'] },
  employee:           { crm: ['view'], tasks: ['view', 'edit'], hr: ['view', 'create', 'edit'], projects: ['view', 'create'], operations: ['view', 'create'] },
  viewer:             { crm: ['view'], sales: ['view'], purchase: ['view'], inventory: ['view'], manufacturing: ['view'], service: ['view'], finance: ['view'], reports: ['view'] }
};

const MODULES = [
  { key: 'dashboard', label: 'Dashboard', description: 'Business overview and live KPIs' },
  { key: 'crm', label: 'CRM', description: 'Leads, customers, deals and tasks' },
  { key: 'sales', label: 'Sales', description: 'Quotations, orders, invoices and receipts' },
  { key: 'purchase', label: 'Purchase', description: 'Requisitions, RFQs, POs and GRNs' },
  { key: 'inventory', label: 'Inventory', description: 'Products, warehouses and stock ledger' },
  { key: 'manufacturing', label: 'Manufacturing', description: 'BOMs and job orders' },
  { key: 'service', label: 'Service', description: 'AMC contracts and tickets' },
  { key: 'finance', label: 'Accounts', description: 'Accounts, journals, expenses and P&L' },
  { key: 'hr', label: 'HR', description: 'Employees, attendance, payroll and leave requests' },
  { key: 'projects', label: 'Projects', description: 'Projects, work orders, milestones and profitability' },
  { key: 'operations', label: 'Operations Inbox', description: 'My work, approvals, alerts and activity' },
  { key: 'reports', label: 'Reports', description: 'Sales, receivables, stock and service reports' },
  { key: 'communication', label: 'Communication', description: 'Email, WhatsApp and customer communication history' },
  { key: 'automation', label: 'Automations', description: 'Business triggers, conditions, actions and execution history' },
  { key: 'dataImport', label: 'Data Import', description: 'Securely map, validate and import previous business data' },
  { key: 'admin', label: 'Administration', description: 'Users, company settings and audit log' }
];

const appGroup = (module, entries) => entries.map(([key, label]) => ({ key, label, module }));
const APP_CATALOG = [
  ...appGroup('dashboard', [['dashboard','Dashboard'],['ai/command-centre','AI Command Centre'],['my-plan','My Plan'],['apps','All Apps'],['onboarding','Get Started'],['my-backup','My Data Backup']]),
  ...appGroup('crm', [['crm/intelligence','Customer Intelligence'],['crm/automation','Sales Automation'],['crm/leads','Leads'],['crm/customers','Customers'],['crm/contacts','Contacts'],['crm/deals','Deals Pipeline'],['crm/tasks','Tasks & Follow-ups'],['crm/meetings','Meetings'],['crm/daily-work','Daily Work Centre'],['crm/late-payments','Late Payments']]),
  ...appGroup('sales', [['sales/recurring','Recurring & Payments'],['sales/quotations','Quotations'],['sales/ai-quote','AI Quote Draft'],['sales/documents','Sales Documents'],['sales/orders','Sales Orders'],['sales/invoices','GST Invoices'],['sales/receipts','Receipts'],['sales/credit-notes','Credit Notes'],['sales/visits','Sales Visits'],['sales/dispatches','Dispatch'],['sales/gate-passes','Gate Passes'],['sales/collections','Collections Centre'],['sales/b2b-commerce','B2B Commerce']]),
  ...appGroup('purchase', [['purchase/requisitions','Requisitions'],['purchase/rfqs','RFQs & Quotes'],['purchase/orders','Purchase Orders'],['purchase/grns','GRN / Receipts'],['purchase/suppliers','Suppliers'],['purchase/billing','Vendor Billing'],['purchase/matching','3-Way Match & Landed Cost']]),
  ...appGroup('inventory', [['inventory/products','Products'],['inventory/summary','Stock Summary'],['inventory/ledger','Stock Ledger'],['inventory/reservations','Reservations'],['inventory/price-lists','Price Lists'],['inventory/assets','Assets'],['inventory/damage-loss','Damage / Loss'],['inventory/quality','Quality & Traceability'],['inventory/warehouse-operations','Warehouse Operations']]),
  ...appGroup('manufacturing', [['manufacturing/planning','MRP & Work Centres'],['manufacturing/boms','BOMs'],['manufacturing/jobs','Job Orders']]),
  ...appGroup('service', [['service/dispatch','Dispatch & Knowledge'],['service/amc','AMC Contracts'],['service/tickets','Service Tickets'],['service/sla-control','SLA & Technician Control']]),
  ...appGroup('finance', [['finance/accounts','Chart of Accounts'],['finance/journals','Journal Entries'],['finance/expenses','Expenses'],['finance/banking','Banking & Reconciliation'],['finance/production-controls','Finance Production Controls'],['finance/petty-cash','Petty Cash'],['finance/cost-centers','Cost Centres'],['finance/cheques','Cheque Status'],['finance/gst-dashboard','GST Dashboard'],['finance/pnl','Profit & Loss'],['finance/ledgers','Ledgers & Statements']]),
  ...appGroup('hr', [['hr/employees','Employees'],['hr/attendance','Attendance'],['hr/payroll','Payroll & Payslips'],['hr/leaves','Leave Requests']]),
  ...appGroup('projects', [['projects/board','Projects & Work Orders']]),
  ...appGroup('operations', [['operations/inbox','Operations Inbox']]),
  ...appGroup('reports', [['reports/builder','Report Builder'],['reports/command','Reports Command Centre'],['reports/sales','Sales Report'],['reports/receivables','Receivables'],['reports/stock','Stock Report'],['reports/funnel','Lead Funnel'],['reports/service','Service Report']]),
  ...appGroup('communication', [['communication/governance','Consent & Segmentation'],['communication/email','Email Centre'],['communication/history','Communication History'],['communication/analytics','Delivery Analytics']]),
  ...appGroup('automation', [['automation/builder','Automation Builder']]),
  ...appGroup('dataImport', [['data-package','Data Package Studio'],['data-import','Import Centre'],['client-documents','Client Documents']]),
  ...appGroup('admin', [['admin/api-hub','API & Integration Hub'],['admin/security','Security Centre'],['admin/subscription','Plan & Subscription'],['admin/subscription-manager','Subscription Manager'],['admin/platform','Platform Control'],['admin/users','Users & Roles'],['admin/approvals','Approval Center'],['admin/integrations','Live Integrations'],['admin/branches','Branches'],['admin/settings','Company Settings'],['admin/sequences','Numbering Series'],['admin/audit','Audit Log']])
];

const DASHBOARD_WIDGETS = [
  { key: 'crmOverview', label: 'CRM Overview', description: 'Open leads, pipeline value and weighted forecast', requiredModule: 'crm' },
  { key: 'receivables', label: 'Receivables', description: 'Outstanding and overdue customer balances', requiredModule: 'sales' },
  { key: 'followUps', label: 'Follow-ups', description: 'Due tasks and overdue follow-up list', requiredModule: 'crm' },
  { key: 'salesMonthly', label: 'Monthly Sales', description: 'Invoices and collections for the current month', requiredModule: 'sales' },
  { key: 'inventoryAlerts', label: 'Inventory Alerts', description: 'Low-stock count and reorder list', requiredModule: 'inventory' },
  { key: 'serviceLoad', label: 'Service Load', description: 'Open service-ticket workload', requiredModule: 'service' },
  { key: 'purchaseStatus', label: 'Purchase Status', description: 'Pending purchase-order count', requiredModule: 'purchase' },
  { key: 'salesTrend', label: 'Sales Trend Chart', description: 'Six-month invoiced-value chart', requiredModule: 'sales' },
  { key: 'leadFunnel', label: 'Lead Funnel Chart', description: 'Lead stage and conversion chart', requiredModule: 'crm' },
  { key: 'recentActivity', label: 'Recent Activity', description: 'Latest CRM activity timeline', requiredModule: 'crm' }
];

function can(subject, module, action) {
  const role = typeof subject === 'string' ? subject : subject && subject.role;
  const overrides = typeof subject === 'object' && subject ? (subject.moduleAccess || {}) : {};
  // Platform Super Admin access cannot be reduced by per-user switches.
  if (role === 'super_admin') return true;
  if (overrides[module] === false) return false;
  if (module === 'dashboard') return overrides[module] !== false;
  if (overrides[module] === true && action === 'view') return true;
  if (role === 'admin') return true;
  const m = ROLE_PERMS[role];
  if (!m) return false;
  if (m['*'] && (m['*'].includes('*') || m['*'].includes(action))) return true;
  const acts = m[module];
  if (!acts) return false;
  return acts.includes('*') || acts.includes(action);
}
function permsForRole(role) {
  if (role === 'super_admin' || role === 'admin') return { '*': ['*'] };
  return ROLE_PERMS[role] || {};
}

function effectiveAccess(user) {
  return Object.fromEntries(MODULES.map(m => [m.key, can(user, m.key, 'view')]));
}

function canUseApp(user, key) {
  const app = APP_CATALOG.find(item => item.key === key);
  if (!app) return true;
  if (!can(user, app.module, 'view')) return false;
  if (user && user.role === 'super_admin') return true;
  return !user || !user.appAccess || user.appAccess[key] !== false;
}

function effectiveAppAccess(user) {
  return Object.fromEntries(APP_CATALOG.map(app => [app.key, canUseApp(user, app.key)]));
}

function canSeeDashboardWidget(user, key) {
  const widget = DASHBOARD_WIDGETS.find(item => item.key === key);
  if (!widget || !can(user, 'dashboard', 'view') || !can(user, widget.requiredModule, 'view')) return false;
  if (user && user.role === 'super_admin') return true;
  return !user || !user.dashboardWidgets || user.dashboardWidgets[key] !== false;
}

function effectiveDashboardWidgets(user) {
  return Object.fromEntries(DASHBOARD_WIDGETS.map(widget => [widget.key, canSeeDashboardWidget(user, widget.key)]));
}

module.exports = {
  r2, fyOf, SEQ_PREFIX, nextNumber, peekNumber, computeDoc, audit, notify,
  postStock, stockBalance, ROLE_PERMS, MODULES, APP_CATALOG, DASHBOARD_WIDGETS, can,
  permsForRole, effectiveAccess, canUseApp, effectiveAppAccess, canSeeDashboardWidget, effectiveDashboardWidgets
};
