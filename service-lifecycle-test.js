/** Isolated AMC and service lifecycle regression. */
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'tdos-service-'));
process.env.AUTO_SEED='true';process.env.JWT_SECRET='service-test-secret-that-is-longer-than-32-characters';process.env.NODE_ENV='test';process.env.INITIAL_SUPERADMIN_PASSWORD='TestSuperAdmin@123';process.env.INITIAL_STAFF_PASSWORD='TestStaffAccount@123';
const app=require('./server'),store=require('./db/store');let passed=0,failed=0,port;
function request(method,p,b,c){return new Promise((resolve,reject)=>{const x=b==null?null:Buffer.from(JSON.stringify(b));const q=http.request({host:'127.0.0.1',port,path:p,method,headers:{...(x?{'Content-Type':'application/json','Content-Length':x.length}:{}),...(c?{Cookie:c}:{})}},r=>{const a=[];r.on('data',v=>a.push(v));r.on('end',()=>{let j={};try{j=JSON.parse(Buffer.concat(a).toString())}catch(_){}resolve({status:r.statusCode,json:j,cookie:r.headers['set-cookie']?.[0]?.split(';')[0]||c});});});q.on('error',reject);if(x)q.write(x);q.end();});}
function check(n,c,e){if(c){passed++;console.log('  PASS  '+n)}else{failed++;console.log('  FAIL  '+n+(e?' -> '+JSON.stringify(e).slice(0,220):''));}}
async function run(){await app.ready;const server=app.listen(0);await new Promise(r=>server.once('listening',r));port=server.address().port;console.log('\n=== Tech Defenders OS service lifecycle regression ===\n');try{
  let r=await request('GET','/api/service/amc-operations');check('service lifecycle requires authentication',r.status===401);
  r=await request('POST','/api/auth/login',{email:'admin@techdefenders.in',password:'TestStaffAccount@123'});const cookie=r.cookie;check('administrator login works',r.status===200&&!!cookie);
  const admin=store.findOne('users',u=>u.email==='admin@techdefenders.in');
  const customer=store.insert('customers',{orgId:admin.orgId,name:'Service Customer',email:'service@example.com'});
  r=await request('POST','/api/service/amc',{customerId:customer.id,assetDesc:'Office HVAC',startDate:'2026-01-01',endDate:'2027-01-01',value:24000,visitsAllowed:4},cookie);const contract=r.json.contract;check('AMC contract is created',r.status===200&&contract?.customerId===customer.id,r.json);
  r=await request('POST','/api/service/amc-assets',{amcId:contract.id,name:'Main HVAC',make:'Carrier',model:'X1',serialNumber:'HVAC-001',installedAt:'2025-01-15',warrantyUntil:'2028-01-15',location:'Server room'},cookie);const asset=r.json.asset;check('AMC equipment stores warranty and serial history',r.status===201&&asset?.serialNumber==='HVAC-001',r.json);
  r=await request('POST','/api/service/amc-assets',{amcId:contract.id,name:'Duplicate',serialNumber:'HVAC-001'},cookie);check('duplicate serial number is blocked',r.status===409,r.json);
  r=await request('POST','/api/service/maintenance-schedules',{assetId:asset.id,title:'Quarterly HVAC service',nextDueDate:'2026-09-21',frequencyDays:90,checklistItems:['Clean filter','Measure temperature']},cookie);const schedule=r.json.schedule;check('preventive schedule is created',r.status===201&&schedule?.checklistItems.length===2,r.json);
  r=await request('POST',`/api/service/maintenance-schedules/${schedule.id}/complete`,{items:[{done:true},{done:false}],notes:'Incomplete'},cookie);check('incomplete mandatory checklist is blocked',r.status===409,r.json);
  r=await request('POST',`/api/service/maintenance-schedules/${schedule.id}/complete`,{items:[{done:true},{done:true}],notes:'All readings normal'},cookie);check('completed checklist advances next due date',r.status===200&&r.json.schedule?.nextDueDate>'2026-09-21'&&r.json.checklist?.items.every(x=>x.done),r.json);
  r=await request('GET',`/api/service/amc-assets/${asset.id}/history`,null,cookie);check('equipment history returns completed maintenance',r.status===200&&r.json.checklists?.length===1,r.json);
  r=await request('POST','/api/service/tickets',{customerId:customer.id,subject:'Cooling alert',priority:'high',amcId:contract.id,amcAssetId:asset.id},cookie);const ticket=r.json.ticket;check('ticket links to AMC equipment',r.status===200&&ticket?.amcAssetId===asset.id,r.json);
  r=await request('POST',`/api/service/tickets/${ticket.id}/feedback`,{rating:5},cookie);check('feedback is blocked before resolution',r.status===409,r.json);
  await request('PATCH',`/api/service/tickets/${ticket.id}/status`,{status:'resolved',note:'Temperature normalized'},cookie);
  r=await request('POST',`/api/service/tickets/${ticket.id}/feedback`,{rating:5,comment:'Excellent response'},cookie);check('resolved ticket records CSAT',r.status===200&&r.json.feedback?.rating===5,r.json);
  const invoice=store.insert('invoices',{orgId:admin.orgId,customerId:customer.id,number:'INV-SVC-1',status:'unpaid',total:24000});
  r=await request('POST',`/api/service/amc/${contract.id}/link-invoice`,{invoiceId:invoice.id},cookie);check('AMC billing links only to matching customer invoice',r.status===200&&r.json.contract?.invoiceId===invoice.id,r.json);
  r=await request('GET','/api/service/amc-operations',null,cookie);check('AMC dashboard returns live renewal, maintenance and CSAT metrics',r.status===200&&r.json.metrics?.assets===1&&r.json.metrics?.csat===5&&r.json.schedules?.length===1,r.json);
  await store.flush();
}finally{await new Promise(r=>server.close(r));await store.close().catch(()=>{});}console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);if(failed)process.exitCode=1;}
run().catch(error=>{console.error(error);process.exitCode=1;});
