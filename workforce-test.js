/** Isolated workforce lifecycle regression. */
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'tdos-workforce-'));
process.env.AUTO_SEED='true';process.env.JWT_SECRET='workforce-test-secret-that-is-longer-than-32-characters';process.env.NODE_ENV='test';process.env.INITIAL_SUPERADMIN_PASSWORD='TestSuperAdmin@123';process.env.INITIAL_STAFF_PASSWORD='TestStaffAccount@123';
const app=require('./server'),store=require('./db/store');let passed=0,failed=0,port;
function request(method,p,b,c){return new Promise((resolve,reject)=>{const x=b==null?null:Buffer.from(JSON.stringify(b));const q=http.request({host:'127.0.0.1',port,path:p,method,headers:{...(x?{'Content-Type':'application/json','Content-Length':x.length}:{}),...(c?{Cookie:c}:{})}},r=>{const a=[];r.on('data',v=>a.push(v));r.on('end',()=>{let j={};try{j=JSON.parse(Buffer.concat(a).toString())}catch(_){}resolve({status:r.statusCode,json:j,cookie:r.headers['set-cookie']?.[0]?.split(';')[0]||c});});});q.on('error',reject);if(x)q.write(x);q.end();});}
function check(n,c,e){if(c){passed++;console.log('  PASS  '+n)}else{failed++;console.log('  FAIL  '+n+(e?' -> '+JSON.stringify(e).slice(0,220):''));}}
async function run(){await app.ready;const server=app.listen(0);await new Promise(r=>server.once('listening',r));port=server.address().port;console.log('\n=== Tech Defenders OS workforce lifecycle regression ===\n');try{
  let r=await request('GET','/api/admin/workforce');check('workforce endpoints require authentication',r.status===401);
  r=await request('POST','/api/auth/login',{email:'admin@techdefenders.in',password:'TestStaffAccount@123'});const cookie=r.cookie;check('administrator login works',r.status===200&&!!cookie);
  r=await request('POST','/api/admin/employees',{name:'Asha Patel',email:'asha@example.com',department:'Operations',designation:'Engineer'},cookie);const employee=r.json.employee;check('employee is created in the existing master',r.status===200&&employee?.name==='Asha Patel');
  r=await request('POST','/api/admin/workforce/departments',{name:'Operations',code:'OPS',managerEmployeeId:employee.id},cookie);const department=r.json.department;check('department is created',r.status===201&&department?.code==='OPS');
  r=await request('POST','/api/admin/workforce/designations',{name:'Field Engineer',departmentId:department.id,grade:'L2'},cookie);check('designation is linked to department',r.status===201&&r.json.designation?.departmentId===department.id);
  r=await request('POST','/api/admin/workforce/holidays',{name:'Foundation Day',date:'2026-10-02'},cookie);check('holiday calendar validates and stores date',r.status===201&&r.json.holiday?.date==='2026-10-02');
  r=await request('POST','/api/admin/workforce/job-openings',{title:'Security Analyst',departmentId:department.id,openings:2,location:'Ahmedabad'},cookie);const opening=r.json.opening;check('job opening enters recruitment pipeline',r.status===201&&opening?.openings===2);
  r=await request('POST','/api/admin/workforce/candidates',{jobOpeningId:opening.id,name:'Ravi Shah',email:'ravi@example.com',source:'Referral'},cookie);const candidate=r.json.candidate;check('candidate is connected to opening',r.status===201&&candidate?.jobOpeningId===opening.id);
  r=await request('PATCH','/api/admin/workforce/candidates/'+candidate.id,{stage:'interview',rating:4.5},cookie);check('candidate pipeline stage updates',r.status===200&&r.json.candidate?.stage==='interview'&&r.json.candidate?.rating===4.5);
  r=await request('POST','/api/admin/workforce/performance-reviews',{employeeId:employee.id,period:'2026 Q3',score:4.2,goals:'Lead two client projects'},cookie);check('performance review is audit-ready',r.status===201&&r.json.review?.score===4.2);
  r=await request('POST','/api/admin/workforce/training-courses',{title:'Secure Field Service',provider:'Tech Defenders',mode:'hybrid',durationHours:6,mandatory:true},cookie);const course=r.json.course;check('training course is created',r.status===201&&course?.mandatory===true);
  r=await request('POST','/api/admin/workforce/training-enrollments',{employeeId:employee.id,courseId:course.id,dueDate:'2026-10-31'},cookie);check('employee training assignment is stored',r.status===201&&r.json.enrollment?.status==='assigned');
  r=await request('GET','/api/admin/workforce',null,cookie);check('workforce dashboard returns tenant-scoped lifecycle data',r.status===200&&r.json.departments?.length===1&&r.json.candidates?.length===1&&r.json.performanceReviews?.length===1&&r.json.trainingEnrollments?.length===1);
  await store.flush();
}finally{await new Promise(r=>server.close(r));await store.close().catch(()=>{});}console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);if(failed)process.exitCode=1;}
run().catch(error=>{console.error(error);process.exitCode=1;});
