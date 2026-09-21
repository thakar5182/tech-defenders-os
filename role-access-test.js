/** Regression checks for category-driven dashboards and least-privilege apps. */
'use strict';
const {
  effectiveAccess, effectiveAppAccess, effectiveDashboardWidgets, canUseApp
} = require('./src/util');

let passed = 0;
const check = (name, condition) => {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
};

const employee = { role: 'employee', moduleAccess: {}, appAccess: {}, dashboardWidgets: {} };
const engineer = { role: 'engineer', moduleAccess: {}, appAccess: {}, dashboardWidgets: {} };
const accountant = { role: 'accountant', moduleAccess: {}, appAccess: {}, dashboardWidgets: {} };
const purchase = { role: 'purchase_manager', moduleAccess: {}, appAccess: {}, dashboardWidgets: {} };

const employeeModules = effectiveAccess(employee);
const employeeApps = effectiveAppAccess(employee);
check('employee sees Employee Desk', employeeApps['hr/self-service'] === true);
check('employee sees assigned-task workspace', employeeApps['crm/tasks'] === true);
check('employee cannot see leads or customer records', employeeApps['crm/leads'] === false && employeeApps['crm/customers'] === false);
check('employee cannot see HR administration', employeeApps['hr/employees'] === false && employeeApps['hr/payroll'] === false);
check('employee cannot see finance, sales or administration modules', !employeeModules.finance && !employeeModules.sales && !employeeModules.admin);
check('employee dashboard hides company-wide KPI widgets', Object.values(effectiveDashboardWidgets(employee)).every(value => value === false));

check('engineer sees service tickets but not AMC management', canUseApp(engineer, 'service/tickets') && !canUseApp(engineer, 'service/amc'));
check('engineer sees operational inventory only', canUseApp(engineer, 'inventory/products') && !canUseApp(engineer, 'inventory/damage-loss'));
check('accountant sees billing and finance but not sales leads', canUseApp(accountant, 'finance/ledgers') && canUseApp(accountant, 'sales/invoices') && !canUseApp(accountant, 'crm/leads'));
check('purchase manager sees procurement but not finance', canUseApp(purchase, 'purchase/orders') && !effectiveAccess(purchase).finance);

const exception = { ...employee, appAccess: { 'crm/leads': true, 'crm/tasks': false } };
check('administrator exception can grant an app inside an allowed module', canUseApp(exception, 'crm/leads') === true);
check('administrator exception can remove a default app', canUseApp(exception, 'crm/tasks') === false);
check('app exception cannot bypass a disabled parent module', canUseApp({ ...exception, moduleAccess: { crm: false } }, 'crm/leads') === false);

console.log(`\nRole access: ${passed}/${passed} passed`);
