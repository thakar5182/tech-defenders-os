'use strict';
const store = require('../../db/store');

const cleanDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : null;

function periodFor(orgId, date) {
  const day = cleanDate(date);
  if (!day) return null;
  return store.findOne('financialPeriods', row => row.orgId === orgId && row.startDate <= day && row.endDate >= day && row.status !== 'void');
}

function assertOpen(orgId, date) {
  const period = periodFor(orgId, date);
  if (period && ['locked', 'closed'].includes(period.status)) {
    const error = new Error(`Accounting period ${period.name} is ${period.status}`);
    error.status = 423;
    error.expose = true;
    throw error;
  }
  return period;
}

module.exports = { periodFor, assertOpen, cleanDate };
