/** Isolated regression for P0 workforce, projects, inbox and encrypted backup agent. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tdos-p0-'));
process.env.AUTO_SEED = 'true';
process.env.JWT_SECRET = 'p0-test-only-secret-that-is-longer-than-32-characters';
process.env.NODE_ENV = 'test';
process.env.INITIAL_SUPERADMIN_PASSWORD = 'TestSuperAdmin@123';
process.env.INITIAL_STAFF_PASSWORD = 'TestStaffAccount@123';
process.env.BACKUP_ENCRYPTION_KEY = 'p0-backup-encryption-key-that-is-longer-than-32-characters';
process.env.BACKUP_AGENT_TOKEN = 'p0-agent-token-that-is-longer-than-32-characters';

const app = require('./server');
const store = require('./db/store');
let passed = 0;
let failed = 0;
let port;

function request(method, requestPath, body, cookie, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = {};
        try { json = JSON.parse(buffer.toString('utf8')); } catch (_) {}
        const setCookie = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          headers: res.headers,
          cookie: setCookie?.[0]?.split(';')[0] || cookie,
          buffer,
          json
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function check(name, condition, extra) {
  if (condition) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra ? ' -> ' + JSON.stringify(extra).slice(0, 300) : ''));
  }
}

async function run() {
  await app.ready;
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  port = server.address().port;
  console.log('\n=== Tech Defenders OS P0 business operations regression ===\n');

  try {
    let response = await request('GET', '/api/p0/inbox');
    check('P0 endpoints require authentication', response.status === 401);

    response = await request('POST', '/api/auth/login', {
      email: 'admin@techdefenders.in',
      password: 'TestStaffAccount@123'
    });
    const cookie = response.cookie;
    check('administrator login works', response.status === 200 && !!cookie);

    const org = store.find('organizations')[0];
    const admin = store.findOne('users', row => row.email === 'admin@techdefenders.in');
    const colleague = store.findOne('users', row => row.email === 'engineer@techdefenders.in');
    const employee = store.insert('employees', {
      orgId: org.id,
      userId: admin.id,
      name: 'P0 Payroll Employee',
      status: 'active',
      basicSalary: 20000,
      professionalTax: 200
    });
    const customer = store.insert('customers', {
      orgId: org.id,
      name: 'P0 Project Customer',
      email: 'p0-customer@example.test'
    });

    response = await request('POST', '/api/p0/attendance/clock-in', {
      employeeId: employee.id,
      workDate: '2026-09-19',
      source: 'p0-test'
    }, cookie);
    const attendance = response.json.attendance;
    check('attendance clock-in is recorded', response.status === 201 && attendance?.employeeId === employee.id);

    response = await request('POST', '/api/p0/attendance/clock-in', {
      employeeId: employee.id,
      workDate: '2026-09-19'
    }, cookie);
    check('duplicate attendance clock-in is blocked', response.status === 409);

    response = await request('POST', '/api/p0/attendance/' + attendance.id + '/clock-out', {}, cookie);
    check('attendance clock-out is recorded', response.status === 200 && !!response.json.attendance?.clockOutAt);

    response = await request('POST', '/api/p0/shifts', {
      name: 'General Shift',
      startTime: '09:30',
      endTime: '18:30',
      graceMinutes: 10
    }, cookie);
    check('shift is created with valid 24-hour times', response.status === 201 && response.json.shift?.name === 'General Shift');

    response = await request('POST', '/api/p0/salary-components', {
      name: 'House Rent Allowance',
      kind: 'earning',
      calculation: 'percent',
      basis: 'basic',
      value: 20
    }, cookie);
    check('salary component is created', response.status === 201 && response.json.component?.value === 20);

    response = await request('PUT', '/api/p0/payroll-policy', {
      enablePf: true,
      pfEmployeeRate: 12,
      pfEmployerRate: 12,
      enableEsi: true,
      esiEligibility: 21000,
      enableProfessionalTax: true,
      defaultProfessionalTax: 200
    }, cookie);
    check('payroll policy is saved', response.status === 200 && response.json.policy?.pfEmployeeRate === 12);

    response = await request('POST', '/api/p0/payroll-runs', { period: '2026-09' }, cookie);
    const payrollRun = response.json.payrollRun;
    check('payroll run creates calculated payslips', response.status === 201 && payrollRun?.employeeCount === 1 && response.json.payslips?.length === 1);

    response = await request('POST', '/api/p0/payroll-runs', { period: '2026-09' }, cookie);
    check('duplicate payroll period is blocked', response.status === 409);

    response = await request('POST', '/api/p0/payroll-runs/' + payrollRun.id + '/publish', {}, cookie);
    check('payroll publishes with explicit accounting status', response.status === 200 && response.json.payrollRun?.status === 'published' && !!response.json.payrollRun?.accountingStatus);

    response = await request('POST', '/api/p0/projects', {
      name: 'Security Operations Rollout',
      customerId: customer.id,
      budget: 100000,
      startDate: '2026-09-19'
    }, cookie);
    const project = response.json.project;
    check('project is created for an organization customer', response.status === 201 && project?.customerId === customer.id);

    response = await request('POST', '/api/p0/projects/' + project.id + '/milestones', {
      title: 'Discovery completed',
      dueDate: '2026-09-25',
      amount: 25000
    }, cookie);
    check('project milestone is created', response.status === 201 && response.json.milestone?.projectId === project.id);

    response = await request('POST', '/api/p0/projects/' + project.id + '/work-orders', {
      title: 'Deploy security controls',
      plannedHours: 20,
      plannedCost: 10000
    }, cookie);
    const workOrder = response.json.workOrder;
    check('project work order is created', response.status === 201 && workOrder?.projectId === project.id);

    response = await request('GET', '/api/p0/projects/' + project.id, null, cookie);
    check('project delivery control returns milestones and tasks', response.status === 200 && response.json.milestones?.length === 1 && response.json.workOrders?.length === 1);

    response = await request('PATCH', '/api/p0/projects/' + project.id + '/milestones/' + response.json.milestones[0].id, { status: 'completed' }, cookie);
    check('milestone status is updated', response.status === 200 && response.json.milestone?.status === 'completed');

    response = await request('PATCH', '/api/p0/projects/' + project.id + '/work-orders/' + workOrder.id, { status: 'in_progress' }, cookie);
    check('work order status is updated', response.status === 200 && response.json.workOrder?.status === 'in_progress');

    response = await request('POST', '/api/p0/projects/' + project.id + '/timesheets', {
      workOrderId: workOrder.id,
      workDate: '2026-09-19',
      hours: 5,
      rate: 1000,
      note: 'P0 test entry'
    }, cookie);
    check('project timesheet is submitted', response.status === 201 && response.json.timesheet?.hours === 5);

    response = await request('GET', '/api/p0/projects/' + project.id + '/profitability', null, cookie);
    check('project profitability derives revenue and costs', response.status === 200 && response.json.revenue === 100000 && response.json.cost === 15000 && response.json.profit === 85000);

    response = await request('POST', '/api/p0/inbox/mentions', {
      userId: colleague.id,
      message: 'Review the rollout plan',
      entityType: 'project',
      entityId: project.id
    }, cookie);
    check('operations mention creates a notification', response.status === 201 && response.json.mention?.userId === colleague.id);

    response = await request('GET', '/api/p0/inbox', null, cookie);
    check('operations inbox returns live work counts', response.status === 200 && typeof response.json.counts?.unreadNotifications === 'number');

    response = await request('GET', '/api/backups/agent/export', null, null, {
      'X-Backup-Agent-Token': 'wrong-token'
    });
    check('backup agent rejects an invalid token', response.status === 404);

    response = await request('GET', '/api/backups/agent/export', null, null, {
      'X-Backup-Agent-Token': process.env.BACKUP_AGENT_TOKEN
    });
    check('backup agent returns an encrypted workspace archive',
      response.status === 200 &&
      String(response.headers['content-type']).includes('application/octet-stream') &&
      response.buffer.subarray(0, 6).toString() === 'TDOSB1' &&
      /^[a-f0-9]{64}$/.test(String(response.headers['x-backup-sha256'] || '')));

    await store.flush();
  } finally {
    await new Promise(resolve => server.close(resolve));
    await store.close().catch(() => {});
  }

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===\n');
  if (failed) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
