'use strict';
const express = require('express');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { audit, notify, nextNumber, r2 } = require('../util');
const router = express.Router();
router.use(requireAuth);

const clean = (value, max = 300) => String(value == null ? '' : value).trim().slice(0, max);
const dateOnly = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : new Date().toISOString().slice(0, 10);
const employees = orgId => store.find('employees', row => row.orgId === orgId && row.status !== 'inactive' && row.active !== false);
const policyFor = orgId => store.findOne('payrollPolicies', row => row.orgId === orgId) || { enablePf: true, pfEmployeeRate: 12, pfEmployerRate: 12, pfWageCeiling: 15000, enableEsi: true, esiEmployeeRate: 0.75, esiEmployerRate: 3.25, esiEligibility: 21000, enableProfessionalTax: true, defaultProfessionalTax: 0 };

function calculatePay(employee, components, policy) {
  const basic = Math.max(0, Number(employee.basicSalary || employee.monthlySalary || 0));
  const earnings = [{ name: 'Basic salary', amount: basic }];
  const deductions = [];
  components.filter(row => row.active !== false).forEach(row => {
    const basis = row.basis === 'ctc' ? Math.max(0, Number(employee.annualCtc || basic * 12)) / 12 : basic;
    const amount = r2(row.calculation === 'percent' ? basis * (Number(row.value) || 0) / 100 : Number(row.value) || 0);
    if (amount > 0) (row.kind === 'deduction' ? deductions : earnings).push({ componentId: row.id, name: row.name, amount, statutory: !!row.statutory });
  });
  const gross = r2(earnings.reduce((sum, row) => sum + row.amount, 0));
  const pfBase = Math.min(basic, Number(policy.pfWageCeiling || 15000));
  const pf = policy.enablePf === false ? 0 : r2(pfBase * (Number(policy.pfEmployeeRate) || 12) / 100);
  const employerPf = policy.enablePf === false ? 0 : r2(pfBase * (Number(policy.pfEmployerRate) || 12) / 100);
  const esiEligible = gross <= (Number(policy.esiEligibility) || 21000);
  const esi = policy.enableEsi === false || !esiEligible ? 0 : r2(gross * (Number(policy.esiEmployeeRate) || 0.75) / 100);
  const employerEsi = policy.enableEsi === false || !esiEligible ? 0 : r2(gross * (Number(policy.esiEmployerRate) || 3.25) / 100);
  const pt = policy.enableProfessionalTax === false ? 0 : r2(Number(employee.professionalTax ?? policy.defaultProfessionalTax) || 0);
  const tds = r2(Number(employee.tdsMonthly) || 0);
  [[pf, 'Provident Fund'], [esi, 'ESI'], [pt, 'Professional Tax'], [tds, 'TDS']].forEach(([amount, name]) => { if (amount) deductions.push({ name, amount, statutory: true }); });
  const totalDeductions = r2(deductions.reduce((sum, row) => sum + row.amount, 0));
  return { basic, gross, earnings, deductions, totalDeductions, netPay: r2(Math.max(0, gross - totalDeductions)), employerContributions: [{ name: 'Employer PF', amount: employerPf }, { name: 'Employer ESI', amount: employerEsi }].filter(row => row.amount), totalEmployerCost: r2(gross + employerPf + employerEsi) };
}

/* Attendance & shifts */
router.get('/attendance', requirePerm('hr', 'view'), (req, res) => res.json({ attendance: store.find('attendanceRecords', row => row.orgId === req.org.id).sort((a,b) => String(b.workDate).localeCompare(String(a.workDate))).slice(0,500) }));
router.post('/attendance/clock-in', requirePerm('hr', 'create'), (req, res) => {
  const b = req.body || {}, employeeId = clean(b.employeeId, 80) || req.user.employeeId || req.user.id, workDate = dateOnly(b.workDate);
  const existing = store.findOne('attendanceRecords', row => row.orgId === req.org.id && row.employeeId === employeeId && row.workDate === workDate);
  if (existing && existing.clockInAt) return res.status(409).json({ error: 'Clock-in is already recorded for this date' });
  const payload = { orgId: req.org.id, employeeId, userId: req.user.id, workDate, status: 'present', clockInAt: new Date().toISOString(), source: clean(b.source || 'web', 30), note: clean(b.note, 300) };
  const attendance = existing ? store.update('attendanceRecords', existing.id, payload) : store.insert('attendanceRecords', payload);
  audit(req.org.id, req.user.id, 'clock_in', 'attendance', attendance.id, { employeeId, workDate });
  res.status(201).json({ attendance });
});
router.post('/attendance/:id/clock-out', requirePerm('hr', 'edit'), (req, res) => {
  const record = store.findOne('attendanceRecords', row => row.id === req.params.id && row.orgId === req.org.id);
  if (!record) return res.status(404).json({ error: 'Attendance record not found' });
  if (!['admin','super_admin'].includes(req.user.role) && record.userId !== req.user.id) return res.status(403).json({ error: 'You may only close your own attendance record' });
  if (record.clockOutAt) return res.status(409).json({ error: 'Clock-out is already recorded' });
  const workedMinutes = Math.max(0, Math.round((Date.now() - new Date(record.clockInAt).getTime()) / 60000));
  const attendance = store.update('attendanceRecords', record.id, { clockOutAt: new Date().toISOString(), workedMinutes, note: clean(req.body?.note || record.note, 300) });
  audit(req.org.id, req.user.id, 'clock_out', 'attendance', record.id, { workedMinutes });
  res.json({ attendance });
});
router.get('/shifts', requirePerm('hr', 'view'), (req, res) => res.json({ shifts: store.find('shifts', row => row.orgId === req.org.id) }));
router.post('/shifts', requirePerm('hr', 'create'), (req, res) => {
  const b = req.body || {};
  if (!clean(b.name) || !/^\d{2}:\d{2}$/.test(clean(b.startTime)) || !/^\d{2}:\d{2}$/.test(clean(b.endTime))) return res.status(400).json({ error: 'Shift name and 24-hour start/end times are required' });
  const shift = store.insert('shifts', { orgId: req.org.id, name: clean(b.name), startTime: clean(b.startTime,5), endTime: clean(b.endTime,5), graceMinutes: Math.max(0, Number(b.graceMinutes) || 0), active: b.active !== false });
  audit(req.org.id, req.user.id, 'create', 'shift', shift.id, { name: shift.name }); res.status(201).json({ shift });
});

/* Salary and payroll */
router.get('/salary-components', requirePerm('hr', 'view'), (req,res) => res.json({ components: store.find('salaryComponents', row => row.orgId === req.org.id), policy: policyFor(req.org.id) }));
router.post('/salary-components', requirePerm('hr', 'create'), (req,res) => {
  const b=req.body||{}; if(!clean(b.name)||Number(b.value)<0)return res.status(400).json({error:'Component name and non-negative value are required'});
  const component=store.insert('salaryComponents',{orgId:req.org.id,name:clean(b.name),kind:b.kind==='deduction'?'deduction':'earning',calculation:b.calculation==='percent'?'percent':'fixed',basis:b.basis==='ctc'?'ctc':'basic',value:r2(Number(b.value)||0),statutory:!!b.statutory,active:b.active!==false});
  audit(req.org.id,req.user.id,'create','salary_component',component.id,{name:component.name});res.status(201).json({component});
});
router.put('/payroll-policy', requirePerm('hr','edit'), (req,res) => {
  const b=req.body||{}, next={enablePf:b.enablePf!==false,pfEmployeeRate:r2(Number(b.pfEmployeeRate)||12),pfEmployerRate:r2(Number(b.pfEmployerRate)||12),pfWageCeiling:r2(Number(b.pfWageCeiling)||15000),enableEsi:b.enableEsi!==false,esiEmployeeRate:r2(Number(b.esiEmployeeRate)||0.75),esiEmployerRate:r2(Number(b.esiEmployerRate)||3.25),esiEligibility:r2(Number(b.esiEligibility)||21000),enableProfessionalTax:b.enableProfessionalTax!==false,defaultProfessionalTax:r2(Number(b.defaultProfessionalTax)||0)};
  const current=store.findOne('payrollPolicies',row=>row.orgId===req.org.id), policy=current?store.update('payrollPolicies',current.id,next):store.insert('payrollPolicies',{orgId:req.org.id,...next});
  audit(req.org.id,req.user.id,'update','payroll_policy',policy.id,{});res.json({policy});
});
router.get('/payroll-runs', requirePerm('hr','view'), (req,res) => res.json({runs:store.find('payrollRuns',row=>row.orgId===req.org.id).sort((a,b)=>String(b.period).localeCompare(String(a.period))),payslips:store.find('payslips',row=>row.orgId===req.org.id).slice(-500)}));
router.post('/payroll-runs', requirePerm('hr','create'), (req,res) => {
  const period=/^\d{4}-\d{2}$/.test(clean(req.body?.period,7))?clean(req.body.period,7):new Date().toISOString().slice(0,7);
  if(store.findOne('payrollRuns',row=>row.orgId===req.org.id&&row.period===period&&row.status!=='void'))return res.status(409).json({error:'A payroll run already exists for this period'});
  const policy=policyFor(req.org.id), components=store.find('salaryComponents',row=>row.orgId===req.org.id), staff=employees(req.org.id), run=store.insert('payrollRuns',{orgId:req.org.id,number:nextNumber(req.org.id,'payroll'),period,status:'draft',createdBy:req.user.id,employeeCount:staff.length,policySnapshot:policy,totals:{gross:0,deductions:0,netPay:0,employerCost:0}});
  const payslips=staff.map(employee=>store.insert('payslips',{orgId:req.org.id,payrollRunId:run.id,number:nextNumber(req.org.id,'payslip'),employeeId:employee.id,employeeName:employee.name,period,status:'draft',...calculatePay(employee,components,policy)}));
  const totals=payslips.reduce((a,s)=>({gross:r2(a.gross+s.gross),deductions:r2(a.deductions+s.totalDeductions),netPay:r2(a.netPay+s.netPay),employerCost:r2(a.employerCost+s.totalEmployerCost)}),{gross:0,deductions:0,netPay:0,employerCost:0});
  const payrollRun=store.update('payrollRuns',run.id,{totals});audit(req.org.id,req.user.id,'create','payroll_run',run.id,{period,employeeCount:staff.length});res.status(201).json({payrollRun,payslips});
});
router.post('/payroll-runs/:id/publish', requirePerm('hr','approve'), (req,res) => {
  const run=store.findOne('payrollRuns',row=>row.id===req.params.id&&row.orgId===req.org.id);if(!run)return res.status(404).json({error:'Payroll run not found'});if(run.status!=='draft')return res.status(409).json({error:'Only a draft payroll run can be published'});
  const expense=store.findOne('accounts',row=>row.orgId===req.org.id&&row.type==='expense'&&/salary|payroll/i.test(row.name)),payable=store.findOne('accounts',row=>row.orgId===req.org.id&&row.type==='liability'&&/salary|payroll/i.test(row.name));
  const journal=expense&&payable&&run.totals.netPay>0?store.insert('journals',{orgId:req.org.id,number:nextNumber(req.org.id,'journal'),date:run.period+'-01',narration:'Payroll payable '+run.period,posted:true,refType:'payroll',refId:run.id,lines:[{accountId:expense.id,debit:run.totals.netPay,credit:0},{accountId:payable.id,debit:0,credit:run.totals.netPay}]}):null;
  const payrollRun=store.update('payrollRuns',run.id,{status:'published',publishedAt:new Date().toISOString(),publishedBy:req.user.id,journalId:journal?.id||null,accountingStatus:journal?'posted':'needs_account_mapping'});
  store.find('payslips',row=>row.orgId===req.org.id&&row.payrollRunId===run.id).forEach(row=>store.update('payslips',row.id,{status:'published',publishedAt:new Date().toISOString()}));
  audit(req.org.id,req.user.id,'publish','payroll_run',run.id,{journalId:journal?.id||null});res.json({payrollRun,journal});
});
router.get('/my/payslips', requirePerm('hr','view'), (req,res) => res.json({payslips:store.find('payslips',row=>row.orgId===req.org.id&&(row.employeeId===req.user.employeeId||row.employeeId===req.user.id)&&row.status==='published')}));

/* Projects, work orders, timesheets and profitability */
router.get('/projects', requirePerm('projects','view'), (req,res) => res.json({projects:store.find('projects',row=>row.orgId===req.org.id).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))}));
router.post('/projects', requirePerm('projects','create'), (req,res) => {
  const b=req.body||{}, customer=store.findOne('customers',row=>row.id===clean(b.customerId,80)&&row.orgId===req.org.id);if(!clean(b.name)||!customer)return res.status(400).json({error:'Project name and valid customer are required'});
  const project=store.insert('projects',{orgId:req.org.id,number:nextNumber(req.org.id,'project'),name:clean(b.name),customerId:customer.id,customerName:customer.name,status:'planned',budget:r2(Number(b.budget)||0),startDate:dateOnly(b.startDate),endDate:clean(b.endDate,10)||null,ownerId:clean(b.ownerId,80)||req.user.id,salesOrderId:clean(b.salesOrderId,80)||null,invoiceId:clean(b.invoiceId,80)||null,createdBy:req.user.id});
  audit(req.org.id,req.user.id,'create','project',project.id,{number:project.number});notify(req.org.id,{userId:project.ownerId,title:'New project assigned',body:project.name,type:'info',link:'#/projects/board'});res.status(201).json({project});
});
router.get('/projects/:id', requirePerm('projects','view'), (req,res) => {
 const project=store.findOne('projects',row=>row.id===req.params.id&&row.orgId===req.org.id);if(!project)return res.status(404).json({error:'Project not found'});
 const milestones=store.find('projectMilestones',row=>row.orgId===req.org.id&&row.projectId===project.id).sort((a,b)=>String(a.dueDate||'').localeCompare(String(b.dueDate||'')));
 const workOrders=store.find('workOrders',row=>row.orgId===req.org.id&&row.projectId===project.id).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
 const timesheets=store.find('timesheets',row=>row.orgId===req.org.id&&row.projectId===project.id).sort((a,b)=>String(b.workDate).localeCompare(String(a.workDate)));
 res.json({project,milestones,workOrders,timesheets});
});
router.post('/projects/:id/milestones', requirePerm('projects','edit'), (req,res) => {
 const project=store.findOne('projects',row=>row.id===req.params.id&&row.orgId===req.org.id);if(!project||!clean(req.body?.title))return res.status(400).json({error:'Valid project and milestone title are required'});const milestone=store.insert('projectMilestones',{orgId:req.org.id,projectId:project.id,title:clean(req.body.title),dueDate:clean(req.body.dueDate,10)||null,amount:r2(Number(req.body.amount)||0),status:'planned',ownerId:clean(req.body.ownerId,80)||project.ownerId});audit(req.org.id,req.user.id,'create','project_milestone',milestone.id,{projectId:project.id});res.status(201).json({milestone});
});
router.patch('/projects/:id/milestones/:milestoneId', requirePerm('projects','edit'), (req,res) => {
 const project=store.findOne('projects',row=>row.id===req.params.id&&row.orgId===req.org.id),milestone=store.findOne('projectMilestones',row=>row.id===req.params.milestoneId&&row.projectId===req.params.id&&row.orgId===req.org.id);if(!project||!milestone)return res.status(404).json({error:'Milestone not found'});
 const patch={};if(req.body?.title!==undefined)patch.title=clean(req.body.title);if(req.body?.dueDate!==undefined)patch.dueDate=clean(req.body.dueDate,10)||null;if(req.body?.amount!==undefined)patch.amount=r2(Number(req.body.amount)||0);if(req.body?.status!==undefined){if(!['planned','in_progress','completed','blocked'].includes(req.body.status))return res.status(400).json({error:'Invalid milestone status'});patch.status=req.body.status;}const updated=store.update('projectMilestones',milestone.id,patch);audit(req.org.id,req.user.id,'update','project_milestone',milestone.id,patch);res.json({milestone:updated});
});
router.post('/projects/:id/work-orders', requirePerm('projects','create'), (req,res) => {
 const project=store.findOne('projects',row=>row.id===req.params.id&&row.orgId===req.org.id);if(!project||!clean(req.body?.title))return res.status(400).json({error:'Valid project and work order title are required'});const workOrder=store.insert('workOrders',{orgId:req.org.id,projectId:project.id,number:nextNumber(req.org.id,'workOrder'),title:clean(req.body.title),status:'open',assignedTo:clean(req.body.assignedTo,80)||null,plannedHours:r2(Number(req.body.plannedHours)||0),plannedCost:r2(Number(req.body.plannedCost)||0),createdBy:req.user.id});audit(req.org.id,req.user.id,'create','work_order',workOrder.id,{projectId:project.id});res.status(201).json({workOrder});
});
router.patch('/projects/:id/work-orders/:workOrderId', requirePerm('projects','edit'), (req,res) => {
 const project=store.findOne('projects',row=>row.id===req.params.id&&row.orgId===req.org.id),order=store.findOne('workOrders',row=>row.id===req.params.workOrderId&&row.projectId===req.params.id&&row.orgId===req.org.id);if(!project||!order)return res.status(404).json({error:'Work order not found'});
 const patch={};if(req.body?.title!==undefined)patch.title=clean(req.body.title);if(req.body?.assignedTo!==undefined)patch.assignedTo=clean(req.body.assignedTo,80)||null;if(req.body?.plannedHours!==undefined)patch.plannedHours=r2(Number(req.body.plannedHours)||0);if(req.body?.plannedCost!==undefined)patch.plannedCost=r2(Number(req.body.plannedCost)||0);if(req.body?.status!==undefined){if(!['open','in_progress','completed','blocked','cancelled'].includes(req.body.status))return res.status(400).json({error:'Invalid work-order status'});patch.status=req.body.status;}const updated=store.update('workOrders',order.id,patch);audit(req.org.id,req.user.id,'update','work_order',order.id,patch);res.json({workOrder:updated});
});
router.post('/projects/:id/timesheets', requirePerm('projects','create'), (req,res) => {
 const project=store.findOne('projects',row=>row.id===req.params.id&&row.orgId===req.org.id),hours=r2(Number(req.body?.hours)||0);if(!project||hours<=0||hours>24)return res.status(400).json({error:'A valid project and 0–24 hours are required'});const timesheet=store.insert('timesheets',{orgId:req.org.id,projectId:project.id,workOrderId:clean(req.body?.workOrderId,80)||null,userId:req.user.id,workDate:dateOnly(req.body?.workDate),hours,rate:r2(Number(req.body?.rate)||0),note:clean(req.body?.note,500),status:'submitted'});audit(req.org.id,req.user.id,'create','timesheet',timesheet.id,{projectId:project.id,hours});res.status(201).json({timesheet});
});
router.get('/projects/:id/profitability', requirePerm('projects','view'), (req,res) => {
 const project=store.findOne('projects',row=>row.id===req.params.id&&row.orgId===req.org.id);if(!project)return res.status(404).json({error:'Project not found'});const time=store.find('timesheets',row=>row.orgId===req.org.id&&row.projectId===project.id),orders=store.find('workOrders',row=>row.orgId===req.org.id&&row.projectId===project.id),invoice=project.invoiceId?store.findOne('invoices',row=>row.id===project.invoiceId&&row.orgId===req.org.id):null,revenue=r2(Number(invoice?.totals?.grandTotal)||Number(project.budget)||0),labourCost=r2(time.reduce((s,row)=>s+(Number(row.hours)||0)*(Number(row.rate)||0),0)),plannedCost=r2(orders.reduce((s,row)=>s+(Number(row.plannedCost)||0),0)),cost=r2(labourCost+plannedCost);res.json({project,revenue,labourCost,plannedCost,cost,profit:r2(revenue-cost),marginPercent:revenue?r2((revenue-cost)/revenue*100):0,hours:r2(time.reduce((s,row)=>s+(Number(row.hours)||0),0))});
});

/* Operations inbox, alerts and mentions */
router.get('/inbox', requirePerm('operations','view'), (req,res) => {
 const orgId=req.org.id,userId=req.user.id,tasks=store.find('tasks',row=>row.orgId===orgId&&row.status!=='done'&&(!row.assignedTo||row.assignedTo===userId)),approvals=store.find('approvalRequests',row=>row.orgId===orgId&&row.status==='pending'),alerts=store.find('tickets',row=>row.orgId===orgId&&!['closed','resolved'].includes(row.status)&&row.slaDueAt&&new Date(row.slaDueAt)<new Date()),notifications=store.find('notifications',row=>row.orgId===orgId&&!row.read&&(!row.userId||row.userId===userId)).slice(-50).reverse(),activity=store.find('auditEvents',row=>row.orgId===orgId).slice(-50).reverse();res.json({tasks,approvals,alerts,notifications,activity,counts:{myWork:tasks.length,pendingApprovals:approvals.length,slaAlerts:alerts.length,unreadNotifications:notifications.length}});
});
router.post('/inbox/mentions', requirePerm('operations','create'), (req,res) => {
 const user=store.findOne('users',row=>row.id===clean(req.body?.userId,80)&&row.orgId===req.org.id&&row.active);if(!user||!clean(req.body?.message))return res.status(400).json({error:'An active colleague and message are required'});const mention=store.insert('mentions',{orgId:req.org.id,userId:user.id,authorId:req.user.id,entityType:clean(req.body?.entityType,50),entityId:clean(req.body?.entityId,80),message:clean(req.body.message,1000),status:'unread'});notify(req.org.id,{userId:user.id,title:'You were mentioned',body:mention.message,type:'info',link:clean(req.body?.link,200)||'#/operations/inbox'});audit(req.org.id,req.user.id,'mention','mention',mention.id,{userId:user.id});res.status(201).json({mention});
});
module.exports = router;
