'use strict';
const express = require('express');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const store = require('../../db/store');
const { requireAuth, requirePerm } = require('../middleware');
const { audit, notify } = require('../util');
const router = express.Router();
router.use(requireAuth);

const clean = (value, max = 300) => String(value == null ? '' : value).trim().slice(0, max);
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;
const SOURCES = { client: 'clientDocuments', customer: 'customerDocuments', supplier: 'supplierDocuments', employee: 'employeeDocuments' };
const MIME = /^data:(application\/pdf|image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;
function source(scope) { return SOURCES[scope] || null; }
function governed(orgId, scope, documentId) { return store.findOne('documentGovernance', row => row.orgId === orgId && row.scope === scope && row.documentId === documentId); }
function safe(row, scope, orgId) {
  const meta = governed(orgId, scope, row.id) || {};
  return { id: row.id, scope, title: row.title || row.filename || row.name || 'Document', type: row.type || row.mimeType || 'file', createdAt: row.createdAt, ownerName: row.clientName || row.customerName || row.supplierName || row.employeeName || '', folderId: meta.folderId || null, tags: meta.tags || [], expiryDate: meta.expiryDate || null, approvalStatus: meta.approvalStatus || 'not_required', version: meta.version || 1, restricted: !!row.restricted };
}
function findDocument(req) {
  const collection = source(req.params.scope);
  return collection && store.findOne(collection, row => row.id === req.params.id && row.orgId === req.org.id);
}
function employeeFor(req) {
  const requested = clean(req.query.employeeId, 80);
  if (requested && ['admin', 'super_admin', 'hr_manager'].includes(req.user.role)) return store.findOne('employees', row => row.id === requested && row.orgId === req.org.id);
  const own = store.findOne('employees', row => row.orgId === req.org.id && (row.userId === req.user.id || (row.email && req.user.email && row.email.toLowerCase() === req.user.email.toLowerCase())));
  if (requested && own) return store.findOne('employees', row => row.id === requested && row.orgId === req.org.id && row.managerEmployeeId === own.id);
  return own;
}

router.get('/documents', requirePerm('dataImport', 'view'), (req, res) => {
  const documents = Object.entries(SOURCES).flatMap(([scope, collection]) => store.find(collection, row => row.orgId === req.org.id).map(row => safe(row, scope, req.org.id))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const folders = store.find('documentFolders', row => row.orgId === req.org.id).sort((a, b) => a.name.localeCompare(b.name));
  const approvals = store.find('documentApprovals', row => row.orgId === req.org.id).slice(-100).reverse();
  res.json({ documents, folders, approvals, metrics: { expiring: documents.filter(row => row.expiryDate && row.expiryDate <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)).length, pending: documents.filter(row => row.approvalStatus === 'pending').length, versions: store.find('documentRevisions', row => row.orgId === req.org.id).length, accessEvents: store.find('documentAccessEvents', row => row.orgId === req.org.id).length } });
});

router.post('/document-folders', requirePerm('dataImport', 'edit'), (req, res) => {
  const name = clean(req.body?.name, 120), parentId = clean(req.body?.parentId, 80) || null;
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  if (parentId && !store.findOne('documentFolders', row => row.id === parentId && row.orgId === req.org.id)) return res.status(400).json({ error: 'Parent folder not found' });
  if (store.findOne('documentFolders', row => row.orgId === req.org.id && row.parentId === parentId && row.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Folder already exists here' });
  const folder = store.insert('documentFolders', { orgId: req.org.id, name, parentId, createdBy: req.user.id });
  audit(req.org.id, req.user.id, 'create', 'document_folder', folder.id, { name }); res.status(201).json({ folder });
});

router.patch('/documents/:scope/:id', requirePerm('dataImport', 'edit'), (req, res) => {
  const document = findDocument(req); if (!document) return res.status(404).json({ error: 'Document not found' });
  const folderId = clean(req.body?.folderId, 80) || null;
  if (folderId && !store.findOne('documentFolders', row => row.id === folderId && row.orgId === req.org.id)) return res.status(400).json({ error: 'Folder not found' });
  const tags = Array.isArray(req.body?.tags) ? [...new Set(req.body.tags.map(value => clean(value, 40)).filter(Boolean))].slice(0, 12) : [];
  const values = { orgId: req.org.id, scope: req.params.scope, documentId: document.id, folderId, tags, expiryDate: date(req.body?.expiryDate), approvalStatus: req.body?.requiresApproval ? 'pending' : 'not_required', version: governed(req.org.id, req.params.scope, document.id)?.version || 1, updatedBy: req.user.id };
  const current = governed(req.org.id, req.params.scope, document.id);
  const governance = current ? store.update('documentGovernance', current.id, values) : store.insert('documentGovernance', values);
  audit(req.org.id, req.user.id, 'govern', 'document', document.id, { scope: req.params.scope, tags, folderId }); res.json({ governance });
});

router.post('/documents/:scope/:id/versions', requirePerm('dataImport', 'edit'), (req, res) => {
  const document = findDocument(req), match = String(req.body?.contentData || '').match(MIME);
  if (!document) return res.status(404).json({ error: 'Document not found' });
  if (!match || String(req.body.contentData).length > 2 * 1024 * 1024) return res.status(400).json({ error: 'PDF, PNG, JPG or WEBP up to 1.5 MB is required' });
  const current = governed(req.org.id, req.params.scope, document.id), version = (current?.version || 1) + 1;
  const revision = store.insert('documentRevisions', { orgId: req.org.id, scope: req.params.scope, documentId: document.id, version, note: clean(req.body?.note, 500), mimeType: match[1], contentData: req.body.contentData, createdBy: req.user.id });
  const values = { orgId: req.org.id, scope: req.params.scope, documentId: document.id, version, folderId: current?.folderId || null, tags: current?.tags || [], expiryDate: current?.expiryDate || null, approvalStatus: current?.approvalStatus === 'approved' ? 'pending' : (current?.approvalStatus || 'not_required'), updatedBy: req.user.id };
  current ? store.update('documentGovernance', current.id, values) : store.insert('documentGovernance', values);
  audit(req.org.id, req.user.id, 'version', 'document', document.id, { version, revisionId: revision.id }); res.status(201).json({ revision: { ...revision, contentData: undefined } });
});

router.post('/documents/:scope/:id/approval', requirePerm('dataImport', 'approve'), (req, res) => {
  const document = findDocument(req), decision = req.body?.decision;
  if (!document) return res.status(404).json({ error: 'Document not found' });
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Approval decision is required' });
  const current = governed(req.org.id, req.params.scope, document.id);
  if (!current || current.approvalStatus !== 'pending') return res.status(409).json({ error: 'Document is not pending approval' });
  const approval = store.insert('documentApprovals', { orgId: req.org.id, scope: req.params.scope, documentId: document.id, version: current.version, decision, comment: clean(req.body?.comment, 500), decidedBy: req.user.id });
  store.update('documentGovernance', current.id, { approvalStatus: decision, approvedRevision: current.version, decidedAt: new Date().toISOString(), decidedBy: req.user.id });
  audit(req.org.id, req.user.id, decision, 'document', document.id, { version: current.version }); res.json({ approval });
});

router.get('/documents/:scope/:id/download', requirePerm('dataImport', 'view'), (req, res) => {
  const document = findDocument(req); if (!document) return res.status(404).json({ error: 'Document not found' });
  const latest = store.find('documentRevisions', row => row.orgId === req.org.id && row.scope === req.params.scope && row.documentId === document.id).sort((a, b) => b.version - a.version)[0];
  const contentData = latest?.contentData || document.contentData;
  const match = String(contentData || '').match(/^data:([^;]+);base64,(.+)$/);
  store.insert('documentAccessEvents', { orgId: req.org.id, scope: req.params.scope, documentId: document.id, action: 'download', userId: req.user.id, ip: req.ip });
  audit(req.org.id, req.user.id, 'download', 'document', document.id, { scope: req.params.scope });
  if (!match && req.params.scope === 'client' && document.storedPath && fs.existsSync(document.storedPath)) return res.download(document.storedPath, document.filename || 'document');
  if (!match) return res.status(409).json({ error: 'Document content is not available' });
  res.setHeader('Content-Type', match[1]); res.setHeader('Content-Disposition', `attachment; filename="${clean(document.title || document.filename || 'document', 100).replace(/[^a-z0-9._-]/gi, '_')}"`); res.send(Buffer.from(match[2], 'base64'));
});

router.post('/employee-documents', requirePerm('hr', 'edit'), (req, res) => {
  const employee = store.findOne('employees', row => row.id === clean(req.body?.employeeId, 80) && row.orgId === req.org.id), match = String(req.body?.contentData || '').match(MIME);
  if (!employee || !clean(req.body?.title, 120) || !match || String(req.body.contentData).length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Employee, title and supported file up to 1.5 MB are required' });
  const document = store.insert('employeeDocuments', { orgId: req.org.id, employeeId: employee.id, employeeName: employee.name, title: clean(req.body.title, 120), type: clean(req.body?.type, 50) || 'employment', mimeType: match[1], contentData: req.body.contentData, visibleToEmployee: req.body?.visibleToEmployee !== false, uploadedBy: req.user.id });
  audit(req.org.id, req.user.id, 'upload', 'employee_document', document.id, { employeeId: employee.id }); res.status(201).json({ document: safe(document, 'employee', req.org.id) });
});

router.get('/self-service', (req, res) => {
  const employee = employeeFor(req); if (!employee) return res.status(404).json({ error: 'Your login is not linked to an employee record. Ask HR to use the same work email.' });
  const own = (collection, predicate = () => true) => store.find(collection, row => row.orgId === req.org.id && row.employeeId === employee.id && predicate(row));
  const enrollments = own('trainingEnrollments').map(row => ({ ...row, course: store.byId('trainingCourses', row.courseId)?.title || 'Training' }));
  const crmTasks = store.find('tasks', row => row.orgId === req.org.id && (row.assignee === employee.userId || row.assignee === req.user.id || row.assignedTo === req.user.id || row.assignedTo === employee.id)).map(row => ({ ...row, source: 'task' }));
  const projectTasks = store.find('workOrders', row => row.orgId === req.org.id && row.assignedTo === employee.userId).map(row => ({ ...row, source: 'project', projectName: store.byId('projects', row.projectId)?.name || 'Project' }));
  const teamMembers = store.find('employees', row => row.orgId === req.org.id && row.managerEmployeeId === employee.id && row.status !== 'inactive').map(row => ({ id: row.id, name: row.name, empCode: row.empCode, designation: row.designation || '', department: row.department || '', loginActive: row.loginActive !== false }));
  res.json({ employee, attendance: own('attendanceRecords').sort((a,b)=>String(b.workDate).localeCompare(String(a.workDate))).slice(0,60), leaves: own('leaveRequests').sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))), payslips: own('payslips', row => row.status === 'published').sort((a,b)=>String(b.period).localeCompare(String(a.period))), training: enrollments, reviews: own('performanceReviews').sort((a,b)=>String(b.reviewDate).localeCompare(String(a.reviewDate))), documents: own('employeeDocuments', row => row.visibleToEmployee !== false).map(row => safe(row, 'employee', req.org.id)), tasks: [...crmTasks, ...projectTasks].sort((a,b)=>String(a.dueDate||'9999').localeCompare(String(b.dueDate||'9999'))), teamMembers });
});

router.post('/self-service/clock-in', (req, res) => {
  const employee = employeeFor(req), workDate = new Date().toISOString().slice(0, 10);
  if (!employee) return res.status(404).json({ error: 'Employee link required' });
  const existing = store.findOne('attendanceRecords', row => row.orgId === req.org.id && row.employeeId === employee.id && row.workDate === workDate);
  if (existing?.clockInAt) return res.status(409).json({ error: 'Clock-in is already recorded for today' });
  const values = { orgId: req.org.id, employeeId: employee.id, userId: req.user.id, workDate, status: 'present', clockInAt: new Date().toISOString(), source: 'employee_desk', note: clean(req.body?.note, 300) };
  const attendance = existing ? store.update('attendanceRecords', existing.id, values) : store.insert('attendanceRecords', values);
  audit(req.org.id, req.user.id, 'clock_in', 'attendance', attendance.id, { employeeId: employee.id, source: 'employee_desk' });
  res.status(201).json({ attendance });
});

router.post('/self-service/clock-out', (req, res) => {
  const employee = employeeFor(req), workDate = new Date().toISOString().slice(0, 10);
  if (!employee) return res.status(404).json({ error: 'Employee link required' });
  const record = store.findOne('attendanceRecords', row => row.orgId === req.org.id && row.employeeId === employee.id && row.userId === req.user.id && row.workDate === workDate);
  if (!record?.clockInAt) return res.status(409).json({ error: 'Clock in before ending your workday' });
  if (record.clockOutAt) return res.status(409).json({ error: 'Clock-out is already recorded for today' });
  const workedMinutes = Math.max(0, Math.round((Date.now() - new Date(record.clockInAt).getTime()) / 60000));
  const attendance = store.update('attendanceRecords', record.id, { clockOutAt: new Date().toISOString(), workedMinutes, note: clean(req.body?.note || record.note, 300) });
  audit(req.org.id, req.user.id, 'clock_out', 'attendance', record.id, { workedMinutes, source: 'employee_desk' });
  res.json({ attendance });
});

router.get('/self-service/documents/:id/download', (req, res) => {
  const employee = employeeFor(req);
  const document = employee && store.findOne('employeeDocuments', row => row.id === req.params.id && row.orgId === req.org.id && row.employeeId === employee.id && row.visibleToEmployee !== false);
  if (!document) return res.status(404).json({ error: 'Employee document not found' });
  const match = String(document.contentData || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.status(409).json({ error: 'Document content is not available' });
  store.insert('documentAccessEvents', { orgId: req.org.id, scope: 'employee', documentId: document.id, action: 'self_download', userId: req.user.id, ip: req.ip });
  res.setHeader('Content-Type', match[1]);
  res.setHeader('Content-Disposition', `attachment; filename="${clean(document.title || 'employee_document', 100).replace(/[^a-z0-9._-]/gi, '_')}"`);
  res.send(Buffer.from(match[2], 'base64'));
});

router.get('/self-service/payslips/:id/pdf', (req, res) => {
  const employee = employeeFor(req);
  const payslip = employee && store.findOne('payslips', row => row.id === req.params.id && row.orgId === req.org.id && row.employeeId === employee.id && row.status === 'published');
  if (!payslip) return res.status(404).json({ error: 'Published payslip not found' });
  const org = req.org, pdf = new PDFDocument({ size: 'A4', margin: 52 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${clean(payslip.number || 'payslip', 80)}.pdf"`);
  pdf.pipe(res);
  pdf.fontSize(20).fillColor('#17150f').text(org.legalName || org.name);
  pdf.moveDown(.25).fontSize(10).fillColor('#777').text(`PAYSLIP · ${payslip.period || ''}`);
  pdf.moveDown(1.5).fontSize(13).fillColor('#17150f').text(employee.name).fontSize(10).text(`${employee.empCode || ''} · ${employee.designation || ''}`);
  pdf.moveDown(1.5).fontSize(11).text(`Basic salary: INR ${Number(payslip.basic || 0).toFixed(2)}`).text(`Gross earnings: INR ${Number(payslip.gross || 0).toFixed(2)}`).text(`Deductions: INR ${Number(payslip.totalDeductions || 0).toFixed(2)}`);
  pdf.moveDown().fontSize(15).fillColor('#8a6814').text(`Net pay: INR ${Number(payslip.netPay || 0).toFixed(2)}`);
  pdf.moveDown(2).fontSize(9).fillColor('#777').text('Private employee document generated by Tech Defenders OS.');
  pdf.end();
});

router.post('/self-service/leaves', (req, res) => {
  const employee = employeeFor(req), fromDate = date(req.body?.fromDate), toDate = date(req.body?.toDate);
  if (!employee || !fromDate || !toDate || toDate < fromDate) return res.status(400).json({ error: 'Valid employee and leave dates are required' });
  const days = Math.max(1, Math.round((new Date(toDate) - new Date(fromDate)) / 86400000) + 1);
  const leave = store.insert('leaveRequests', { orgId: req.org.id, employeeId: employee.id, type: clean(req.body?.type, 30) || 'casual', fromDate, toDate, days, reason: clean(req.body?.reason, 500), status: 'pending', requestedBy: req.user.id });
  notify(req.org.id, { title: 'Leave approval required', body: `${employee.name} requested ${days} day(s)`, type: 'info', link: '#/hr/leaves' }); audit(req.org.id, req.user.id, 'create', 'leave_request', leave.id, { employeeId: employee.id, days }); res.status(201).json({ leave });
});

module.exports = router;
