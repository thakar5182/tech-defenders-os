/**
 * Clean workspace initializer.
 *
 * Creates only:
 *   - the required Tech Defenders organization record;
 *   - the nine requested login accounts;
 *   - numbering sequences and a standard chart of accounts required by the app.
 *
 * No demo customers, leads, products, warehouses, stock, transactions,
 * invoices, quotations, suppliers, employees, tickets or analytics records
 * are created.
 *
 * Run manually:   node db/seed.js --force
 * Automatic:      runs on first boot when AUTO_SEED=true and no users exist.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const store = require('./store');

const DATA_DIR = store.DATA_DIR;

function financialYearStart() {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
}

function wipe() {
  for (const collection of store.COLLECTIONS) {
    const file = path.join(DATA_DIR, collection + '.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function syncSuperAdminPassword() {
  if (process.env.SYNC_SUPERADMIN_PASSWORD !== 'true') return false;
  const password = String(process.env.INITIAL_SUPERADMIN_PASSWORD || '');
  if (password.length < 12) {
    throw new Error('INITIAL_SUPERADMIN_PASSWORD must contain at least 12 characters when recovery is enabled');
  }
  const user = store.findOne('users', item => item.email === 'superadmin@techdefenders.in' && item.role === 'super_admin');
  if (!user) throw new Error('Super Admin recovery requested, but the Super Admin account was not found');
  if (!bcrypt.compareSync(password, user.passwordHash)) {
    store.update('users', user.id, {
      passwordHash: bcrypt.hashSync(password, 10),
      tokenVersion: Number(user.tokenVersion || 0) + 1,
      active: true,
      mustChangePassword: false
    });
    console.log('[init] Super Admin password synchronized from secure environment configuration.');
  }
  return true;
}

async function run(force) {
  if (!process.env.DATABASE_URL) store.load();
  if (!force && !store.isEmpty()) {
    syncSuperAdminPassword();
    await store.flush();
    console.log('[init] Workspace already has user accounts - no changes made.');
    return false;
  }
  if (force) {
    console.log('[init] Clearing existing business data...');
    wipe();
    store.reset();
  }

  const organization = store.insert('organizations', {
    name: 'Tech Defenders',
    legalName: 'Tech Defenders',
    gstin: '',
    pan: '',
    email: 'admin@techdefenders.in',
    phone: '',
    address: { line1: '', city: '', state: 'Gujarat', pincode: '' },
    stateCode: '24',
    currency: 'INR',
    financialYearStart: financialYearStart(),
    timezone: 'Asia/Kolkata',
    taxMode: 'exclusive',
    allowNegativeStock: false
  });
  const orgId = organization.id;

  const superAdminPassword = String(process.env.INITIAL_SUPERADMIN_PASSWORD || '');
  if (superAdminPassword.length < 12) {
    throw new Error('INITIAL_SUPERADMIN_PASSWORD must contain at least 12 characters');
  }
  const configuredStaffPassword = String(process.env.INITIAL_STAFF_PASSWORD || '');
  if (configuredStaffPassword && configuredStaffPassword.length < 12) {
    throw new Error('INITIAL_STAFF_PASSWORD must contain at least 12 characters when configured');
  }
  const randomPassword = () => configuredStaffPassword || crypto.randomBytes(24).toString('base64url');

  const accounts = [
    ['Tech Defenders Super Admin', 'superadmin@techdefenders.in', 'super_admin', superAdminPassword],
    ['Tech Defenders Admin', 'admin@techdefenders.in', 'admin', randomPassword()],
    ['Sales Manager', 'sales@techdefenders.in', 'sales_manager', randomPassword()],
    ['Accountant', 'accounts@techdefenders.in', 'accountant', randomPassword()],
    ['Purchase Manager', 'purchase@techdefenders.in', 'purchase_manager', randomPassword()],
    ['Store Manager', 'store@techdefenders.in', 'store_manager', randomPassword()],
    ['Production Manager', 'production@techdefenders.in', 'production_manager', randomPassword()],
    ['Service Manager', 'service@techdefenders.in', 'service_manager', randomPassword()],
    ['Engineer', 'engineer@techdefenders.in', 'engineer', randomPassword()]
  ];
  for (const [name, email, role, password] of accounts) {
    store.insert('users', {
      orgId,
      name,
      email,
      role,
      phone: '',
      passwordHash: bcrypt.hashSync(password, 10),
      active: true,
      tokenVersion: 0,
      mustChangePassword: false,
      moduleAccess: {},
      dashboardWidgets: {}
    });
  }

  for (const type of [
    'quotation', 'salesOrder', 'invoice', 'receipt', 'creditNote',
    'requisition', 'rfq', 'purchaseOrder', 'grn', 'jobOrder',
    'ticket', 'amc', 'journal', 'expense', 'proforma', 'deliveryChallan',
    'debitNote', 'purchaseInvoice', 'purchaseReturn', 'supplierPayment',
    'reservation', 'approval', 'bankTransaction'
  ]) {
    store.insert('sequences', { orgId, type, nextNumber: 1 });
  }

  const chartOfAccounts = [
    ['1000', 'Cash in Hand', 'asset'], ['1010', 'Bank Account', 'asset'],
    ['1100', 'Accounts Receivable', 'asset'], ['1200', 'Inventory', 'asset'],
    ['1300', 'GST Input Credit', 'asset'],
    ['2000', 'Accounts Payable', 'liability'], ['2100', 'GST Output Payable', 'liability'],
    ['3000', 'Owner Capital', 'equity'], ['3100', 'Retained Earnings', 'equity'],
    ['4000', 'Sales Revenue', 'income'], ['4100', 'Service Revenue', 'income'],
    ['4200', 'AMC Revenue', 'income'],
    ['5000', 'Cost of Goods Sold', 'expense'], ['5100', 'Salaries', 'expense'],
    ['5200', 'Rent', 'expense'], ['5300', 'Utilities', 'expense'],
    ['5400', 'Marketing', 'expense'], ['5500', 'Travel', 'expense'],
    ['5600', 'Office Supplies', 'expense'], ['5700', 'Purchases', 'expense']
  ];
  for (const [code, name, type] of chartOfAccounts) {
    store.insert('accounts', { orgId, code, name, type });
  }

  await store.flush();
  console.log('[init] Clean Tech Defenders workspace ready.');
  console.log('[init] Retained: 9 login accounts, numbering series and required chart of accounts.');
  console.log('[init] Business/demo records: 0.');
  return true;
}

if (require.main === module) {
  (async () => {
    await store.initialize();
    await run(process.argv.includes('--force'));
    await store.close();
  })().catch(error => { console.error('[init]', error.message); process.exit(1); });
}
module.exports = { run, syncSuperAdminPassword };
