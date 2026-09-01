'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// Maintained SheetJS 0.20.x package; avoids the unpatched legacy `xlsx` npm release.
const XLSX = require('@e965/xlsx');
const { PDFParse } = require('pdf-parse');
const yauzl = require('yauzl');
const { XMLParser } = require('fast-xml-parser');
const store = require('../../db/store');
const { r2, nextNumber, postStock, audit } = require('../util');

const MAX_ARCHIVE_FILES = Number(process.env.IMPORT_MAX_ARCHIVE_FILES) || 250;
const MAX_EXTRACTED_BYTES = (Number(process.env.IMPORT_MAX_EXTRACTED_MB) || 100) * 1024 * 1024;
const MAX_FILE_BYTES = (Number(process.env.IMPORT_MAX_FILE_MB) || 25) * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.zip', '.csv', '.xlsx', '.xls', '.json', '.pdf', '.xml']);
const RESTRICTED_EXTENSIONS = new Set(['.exe', '.dll', '.com', '.bat', '.cmd', '.ps1', '.js', '.mjs', '.cjs', '.jar', '.msi', '.scr', '.vbs', '.sh']);
const PACKAGE_MANIFEST = 'tech-defenders-manifest.json';
const DOCUMENT_CATEGORIES = new Set(['contracts', 'identity', 'legal', 'finance', 'projects', 'media', 'technical', 'archives', 'general', 'restricted']);

const defs = {
  customers: {
    collection: 'customers', required: ['name'], label: 'Customers',
    fields: {
      name: ['customer name', 'client name', 'party name', 'buyer name', 'customer', 'client'],
      phone: ['mobile', 'phone', 'phone number', 'contact no', 'contact number', 'mob no', 'mobile no'],
      email: ['email', 'email address', 'mail'], gstin: ['gstin', 'gst no', 'gst number', 'tax id'],
      address: ['address', 'billing address', 'customer address'], stateCode: ['state code', 'gst state code'],
      contactPerson: ['contact person', 'contact name'], creditLimit: ['credit limit'], paymentTermsDays: ['payment terms', 'credit days']
    }
  },
  leads: {
    collection: 'leads', required: ['name'], label: 'Leads',
    fields: {
      name: ['lead name', 'customer name', 'prospect name', 'name'], company: ['company', 'business name', 'organization'],
      phone: ['mobile', 'phone', 'contact no', 'mobile no'], email: ['email', 'email address'],
      source: ['source', 'lead source'], status: ['status', 'lead status'], value: ['value', 'deal value', 'estimated value'],
      productInterest: ['product interest', 'requirement', 'interested in']
    }
  },
  products: {
    collection: 'products', required: ['name'], label: 'Products / Inventory',
    fields: {
      name: ['product name', 'item name', 'product', 'item', 'description'], sku: ['sku', 'product code', 'item code', 'barcode'],
      hsn: ['hsn', 'hsn code', 'sac', 'hsn/sac'], quantity: ['quantity', 'qty', 'stock', 'opening stock', 'current stock'],
      purchasePrice: ['purchase price', 'cost price', 'buy price', 'cost'], salePrice: ['selling price', 'sale price', 'rate', 'mrp'],
      gstRate: ['gst', 'gst rate', 'tax rate'], minStock: ['minimum stock', 'min stock', 'reorder level'], uom: ['unit', 'uom'],
      category: ['category', 'product category'], type: ['type', 'product type']
    }
  },
  invoices: {
    collection: 'invoices', required: ['number', 'date', 'customer', 'total'], label: 'Bills / Invoices',
    fields: {
      number: ['invoice no', 'invoice number', 'bill no', 'bill number', 'voucher no'], date: ['invoice date', 'bill date', 'date'],
      customer: ['customer', 'customer name', 'client', 'party name', 'buyer name'], gstin: ['gstin', 'customer gstin'],
      subtotal: ['subtotal', 'taxable amount', 'taxable value'], gst: ['gst', 'tax amount', 'total tax'], total: ['total', 'grand total', 'invoice total', 'net amount'],
      paidAmount: ['paid amount', 'amount paid'], paymentStatus: ['payment status', 'status'], dueDate: ['due date', 'payment due date'], notes: ['notes', 'remarks']
    }
  },
  quotations: {
    collection: 'quotations', required: ['number', 'date', 'customer', 'total'], label: 'Quotations',
    fields: {
      number: ['quotation no', 'quote no', 'quotation number', 'estimate no'], date: ['quotation date', 'quote date', 'date'],
      customer: ['customer', 'customer name', 'client', 'party name'], subtotal: ['subtotal', 'taxable amount'], gst: ['gst', 'tax amount'],
      total: ['total', 'grand total', 'quotation total'], status: ['status', 'quotation status'], validUntil: ['valid until', 'expiry date'], notes: ['notes', 'remarks']
    }
  },
  payments: {
    collection: 'receipts', required: ['date', 'customer', 'amount'], label: 'Payments',
    fields: {
      number: ['receipt no', 'payment no', 'voucher no', 'transaction id'], date: ['payment date', 'receipt date', 'date'],
      customer: ['customer', 'customer name', 'party name', 'client'], invoiceNumber: ['invoice no', 'bill no', 'invoice number'],
      amount: ['amount', 'paid amount', 'payment amount'], mode: ['mode', 'payment mode', 'method'], reference: ['reference', 'transaction reference', 'utr']
    }
  },
  expenses: {
    collection: 'expenses', required: ['date', 'amount'], label: 'Expenses',
    fields: {
      date: ['expense date', 'date'], number: ['expense no', 'voucher no'], category: ['category', 'expense category'],
      description: ['description', 'particulars', 'expense'], amount: ['amount', 'expense amount', 'total'], vendor: ['vendor', 'supplier', 'paid to'],
      mode: ['payment mode', 'mode'], status: ['status', 'approval status']
    }
  },
  suppliers: {
    collection: 'suppliers', required: ['name'], label: 'Vendors / Suppliers',
    fields: {
      name: ['supplier name', 'vendor name', 'party name', 'supplier', 'vendor'], phone: ['phone', 'mobile', 'contact no'],
      email: ['email', 'email address'], gstin: ['gstin', 'gst no'], address: ['address', 'supplier address'], paymentTermsDays: ['payment terms', 'credit days']
    }
  },
  employees: {
    collection: 'employees', required: ['name'], label: 'Employees',
    fields: {
      name: ['employee name', 'staff name', 'name'], email: ['email', 'work email'], phone: ['phone', 'mobile'],
      department: ['department', 'dept'], designation: ['designation', 'job title', 'role'], joiningDate: ['joining date', 'date of joining'], salary: ['salary', 'monthly salary']
    }
  },
  tickets: {
    collection: 'tickets', required: ['subject'], label: 'Service Records',
    fields: {
      number: ['ticket no', 'service no', 'complaint no'], customer: ['customer', 'customer name', 'client'],
      subject: ['subject', 'issue', 'complaint', 'service description'], status: ['status', 'ticket status'], priority: ['priority', 'severity'],
      date: ['date', 'created date'], description: ['description', 'details', 'remarks']
    }
  },
  amc: {
    collection: 'amcContracts', required: ['customer', 'endDate'], label: 'AMC Records',
    fields: {
      number: ['amc no', 'contract no'], customer: ['customer', 'customer name', 'client'], asset: ['asset', 'asset description', 'product'],
      startDate: ['start date', 'amc start'], endDate: ['end date', 'expiry date', 'renewal date'], value: ['value', 'amc value', 'amount'],
      status: ['status', 'amc status'], visitsAllowed: ['visits', 'visits allowed']
    }
  }
};

const normalize = value => String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cleanText = (value, max = 500) => String(value == null ? '' : value).trim().slice(0, max);
const number = value => {
  const parsed = Number(String(value == null ? '' : value).replace(/[₹,$%\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};
const isoDate = value => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && value > 1000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = cleanText(value, 50);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/.exec(text);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
};

function distance(a, b) {
  const rows = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = rows[0]; rows[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = rows[j];
      rows[j] = Math.min(rows[j] + 1, rows[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = old;
    }
  }
  return rows[b.length];
}

function scoreAlias(header, alias) {
  const h = normalize(header), a = normalize(alias);
  if (!h || !a) return 0;
  if (h === a) return 1;
  if (h.includes(a) || a.includes(h)) return Math.min(h.length, a.length) / Math.max(h.length, a.length) * 0.9;
  return Math.max(0, 1 - distance(h, a) / Math.max(h.length, a.length));
}

function bestMapping(headers, def) {
  return headers.map(header => {
    let best = { field: null, confidence: 0 };
    for (const [field, aliases] of Object.entries(def.fields)) {
      for (const alias of [field, ...aliases]) {
        const confidence = scoreAlias(header, alias);
        if (confidence > best.confidence) best = { field, confidence };
      }
    }
    return { column: header, field: best.confidence >= 0.55 ? best.field : null, confidence: Number(best.confidence.toFixed(2)), accepted: best.confidence >= 0.72 };
  });
}

function detectEntity(headers) {
  let best = null;
  for (const [entity, def] of Object.entries(defs)) {
    const mappings = bestMapping(headers, def);
    const mapped = mappings.filter(item => item.field && item.confidence >= 0.62);
    const unique = new Set(mapped.map(item => item.field));
    const requiredHit = def.required.filter(field => unique.has(field)).length;
    const score = mapped.reduce((sum, item) => sum + item.confidence, 0) + requiredHit * 1.5;
    if (!best || score > best.score) best = { entity, def, mappings, score, requiredHit };
  }
  if (!best || best.score < 1.2) return { entity: 'unknown', mappings: [], confidence: 0 };
  return { entity: best.entity, mappings: best.mappings, confidence: Number(Math.min(1, best.score / Math.max(headers.length, 3)).toFixed(2)) };
}

function rowsFromSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  return rows.slice(0, 100000).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [cleanText(key, 120), value])));
}

function largestObjectArray(value) {
  let best = [], bestSingle = null, bestSingleScore = 0;
  const visit = item => {
    if (Array.isArray(item)) {
      if (item.length > best.length && item.every(row => row && typeof row === 'object' && !Array.isArray(row))) best = item;
      item.forEach(visit);
    } else if (item && typeof item === 'object') {
      const primitiveCount = Object.values(item).filter(value => value == null || typeof value !== 'object').length;
      if (primitiveCount > bestSingleScore) { bestSingle = item; bestSingleScore = primitiveCount; }
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return best.length ? best : (bestSingle ? [bestSingle] : []);
}

async function parseFile(name, buffer) {
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext) || ext === '.zip') throw new Error(`Unsupported file type: ${ext || 'unknown'}`);
  if (buffer.length > MAX_FILE_BYTES) throw new Error(`${name} exceeds the per-file extraction limit`);
  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, WTF: false });
    return workbook.SheetNames.map(sheetName => ({ sourceName: `${name} · ${sheetName}`, rows: rowsFromSheet(workbook.Sheets[sheetName]) })).filter(item => item.rows.length);
  }
  if (ext === '.json') {
    const parsed = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
    const rows = Array.isArray(parsed) ? parsed : largestObjectArray(parsed);
    return [{ sourceName: name, rows: rows.filter(row => row && typeof row === 'object' && !Array.isArray(row)) }];
  }
  if (ext === '.xml') {
    const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: true, trimValues: true }).parse(buffer.toString('utf8'));
    return [{ sourceName: name, rows: largestObjectArray(parsed) }];
  }
  const parser = new PDFParse({ data: buffer });
  let parsed;
  try {
    parsed = await parser.getText();
  } finally {
    await parser.destroy();
  }
  const lines = String(parsed.text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) return [{ sourceName: name, rows: [], warning: 'PDF text was detected but no table-like rows could be identified' }];
  const split = line => line.includes('|') ? line.split('|') : (line.includes(',') ? line.split(',') : line.split(/\s{2,}/));
  const headers = split(lines[0]).map(value => cleanText(value, 120));
  const rows = lines.slice(1).map(line => Object.fromEntries(headers.map((header, index) => [header, cleanText(split(line)[index] || '')])));
  return [{ sourceName: name, rows, warning: 'PDF table extraction is best-effort; verify every mapped field before import' }];
}

function openZip(buffer) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}

async function parseArchive(buffer) {
  const zip = await openZip(buffer);
  return new Promise((resolve, reject) => {
    const files = [];
    let manifest = null;
    let count = 0, total = 0, settled = false;
    const fail = error => { if (!settled) { settled = true; try { zip.close(); } catch (_) {} reject(error); } };
    zip.on('error', fail);
    zip.on('end', () => { if (!settled) { settled = true; resolve({ files, manifest }); } });
    zip.on('entry', entry => {
      const name = entry.fileName.replace(/\\/g, '/');
      if (/\/$/.test(name)) return zip.readEntry();
      count += 1; total += Number(entry.uncompressedSize) || 0;
      const ext = path.extname(name).toLowerCase();
      if (count > MAX_ARCHIVE_FILES) return fail(new Error('Archive contains too many files'));
      if (total > MAX_EXTRACTED_BYTES || entry.uncompressedSize > MAX_FILE_BYTES) return fail(new Error('Archive extraction limit exceeded'));
      if (name.startsWith('/') || name.split('/').includes('..')) return fail(new Error(`Unsafe archive entry rejected: ${name}`));
      zip.openReadStream(entry, (error, stream) => {
        if (error) return fail(error);
        const chunks = []; let read = 0;
        stream.on('data', chunk => { read += chunk.length; if (read > MAX_FILE_BYTES) stream.destroy(new Error('Archive entry limit exceeded')); else chunks.push(chunk); });
        stream.on('error', fail);
        stream.on('end', () => {
          const data = Buffer.concat(chunks);
          if (name === PACKAGE_MANIFEST) {
            try {
              const parsed = JSON.parse(data.toString('utf8'));
              if (parsed.format !== 'tech-defenders-data-package' || parsed.version !== 1 || !Array.isArray(parsed.files)) throw new Error('Manifest schema is invalid');
              manifest = parsed;
            } catch (error) { return fail(new Error(`Data package manifest is invalid: ${error.message}`)); }
          } else files.push({ name, buffer: data, restricted: RESTRICTED_EXTENSIONS.has(ext) });
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

function filenameEntity(name) {
  const value = normalize(path.basename(name, path.extname(name)));
  const rules = {
    customers: ['customer', 'client', 'party', 'buyer'], leads: ['lead', 'prospect', 'enquiry', 'inquiry'],
    products: ['product', 'inventory', 'stock', 'item', 'catalog'], invoices: ['invoice', 'bill', 'sales bill'],
    quotations: ['quotation', 'quote', 'estimate'], payments: ['payment', 'receipt', 'collection'],
    expenses: ['expense', 'cost'], suppliers: ['supplier', 'vendor'], employees: ['employee', 'staff', 'hr'],
    tickets: ['ticket', 'service', 'complaint'], amc: ['amc', 'contract renewal']
  };
  for (const [entity, terms] of Object.entries(rules)) if (terms.some(term => value.includes(term))) return entity;
  return null;
}

function documentCategory(name, restricted = false) {
  if (restricted || RESTRICTED_EXTENSIONS.has(path.extname(name).toLowerCase())) return 'restricted';
  const value = normalize(name), ext = path.extname(name).toLowerCase();
  if (/(contract|agreement|nda|proposal|scope|sow)/.test(value)) return 'contracts';
  if (/(aadhaar|aadhar|pan card|passport|identity|kyc)/.test(value)) return 'identity';
  if (/(legal|license|licence|certificate|registration|gst)/.test(value)) return 'legal';
  if (/(bank|statement|tax|finance|account)/.test(value)) return 'finance';
  if (/(project|brief|design|wireframe|source)/.test(value)) return 'projects';
  if (['.jpg','.jpeg','.png','.gif','.webp','.svg','.mp4','.mov','.avi','.mp3','.wav','.m4a'].includes(ext)) return 'media';
  if (['.zip','.rar','.7z','.tar','.gz'].includes(ext)) return 'archives';
  if (['.html','.css','.ts','.tsx','.jsx','.py','.java','.sql','.md','.txt'].includes(ext)) return 'technical';
  return 'general';
}

async function classifyPackageFile(name, buffer) {
  const ext = path.extname(name).toLowerCase();
  const byName = filenameEntity(name);
  if (ALLOWED_EXTENSIONS.has(ext) && ext !== '.zip') {
    try {
      const datasets = await parseFile(name, buffer);
      const rows = datasets.flatMap(item => item.rows || []);
      const headers = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 250);
      const detected = detectEntity(headers);
      const entity = detected.entity !== 'unknown' ? detected.entity : byName;
      if (entity) return { kind: 'business-data', entity, confidence: Math.max(detected.confidence || 0, byName ? .68 : 0), reason: detected.entity !== 'unknown' ? 'Content and column structure matched' : 'Filename matched' };
    } catch (_) { /* keep as a document when content extraction is not possible */ }
  }
  if (byName && ['.csv','.xlsx','.xls','.json','.xml','.pdf'].includes(ext)) return { kind: 'business-data', entity: byName, confidence: .62, reason: 'Filename matched a business module' };
  const category = documentCategory(name);
  return { kind: 'document', category, confidence: category === 'general' ? .45 : .78, reason: category === 'general' ? 'Kept in General Documents for review' : 'File name and type matched' };
}

function manifestTarget(manifest, inputName) {
  if (!manifest) return null;
  const item = manifest.files.find(file => file && file.storedName === inputName);
  if (!item || !item.target) return null;
  if (item.target.kind === 'business-data' && defs[item.target.entity]) return { kind: 'business-data', entity: item.target.entity };
  if (item.target.kind === 'document') return { kind: 'document', category: DOCUMENT_CATEGORIES.has(item.target.category) ? item.target.category : 'general' };
  return null;
}

function stageDocument(job, orgId, input, target, manifestItem) {
  const dir = path.join(store.DATA_DIR, 'import-staging', job.id);
  fs.mkdirSync(dir, { recursive: true });
  const id = store.id();
  const stagedPath = path.join(dir, `${id}.bin`);
  fs.writeFileSync(stagedPath, input.buffer, { flag: 'wx' });
  return store.insert('importFiles', {
    id, orgId, importJobId: job.id, filename: cleanText(manifestItem?.originalName || input.name, 300),
    size: input.buffer.length, type: path.extname(input.name).toLowerCase().slice(1) || 'file', kind: 'document',
    documentCategory: target.category || documentCategory(input.name, input.restricted), restricted: input.restricted === true,
    stagedPath, sourceHash: crypto.createHash('sha256').update(input.buffer).digest('hex'), recordCount: 0
  });
}

function mappedRow(row, mappings) {
  const output = {};
  for (const mapping of mappings) if (mapping.field && mapping.accepted !== false) output[mapping.field] = row[mapping.column];
  return output;
}

function duplicateFor(orgId, entity, row) {
  const norm = value => normalize(value).replace(/\s/g, '');
  if (entity === 'customers') return store.findOne('customers', item => item.orgId === orgId && ((row.phone && norm(item.phone) === norm(row.phone)) || (row.email && norm(item.email) === norm(row.email)) || (row.gstin && norm(item.gstin) === norm(row.gstin))));
  if (entity === 'leads') return store.findOne('leads', item => item.orgId === orgId && ((row.phone && norm(item.phone) === norm(row.phone)) || (row.email && norm(item.email) === norm(row.email))));
  if (entity === 'products') return store.findOne('products', item => item.orgId === orgId && ((row.sku && norm(item.sku) === norm(row.sku)) || (!row.sku && row.name && norm(item.name) === norm(row.name))));
  if (entity === 'invoices') return store.findOne('invoices', item => item.orgId === orgId && norm(item.number) === norm(row.number));
  if (entity === 'quotations') return store.findOne('quotations', item => item.orgId === orgId && norm(item.number) === norm(row.number));
  if (entity === 'suppliers') return store.findOne('suppliers', item => item.orgId === orgId && ((row.gstin && norm(item.gstin) === norm(row.gstin)) || (row.email && norm(item.email) === norm(row.email)) || norm(item.name) === norm(row.name)));
  if (entity === 'employees') return store.findOne('employees', item => item.orgId === orgId && row.email && norm(item.email) === norm(row.email));
  return null;
}

function validateRow(entity, row, def, orgId) {
  const errors = [], warnings = [];
  for (const field of def.required) if (!cleanText(row[field])) errors.push(`${field} is required`);
  if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(row.email, 180))) errors.push('email is invalid');
  if (row.phone && cleanText(row.phone).replace(/\D/g, '').length < 7) warnings.push('phone number appears incomplete');
  for (const field of ['date', 'dueDate', 'validUntil', 'startDate', 'endDate', 'joiningDate']) if (row[field] && !isoDate(row[field])) errors.push(`${field} could not be understood`);
  for (const field of ['total', 'amount', 'quantity', 'purchasePrice', 'salePrice', 'value']) if (row[field] !== undefined && row[field] !== '' && !Number.isFinite(number(row[field]))) errors.push(`${field} is not numeric`);
  const duplicate = duplicateFor(orgId, entity, row);
  if (duplicate) warnings.push('Possible duplicate found in existing data');
  return { errors, warnings, duplicateId: duplicate ? duplicate.id : null };
}

async function analyseUpload(jobId, orgId, upload) {
  const job = store.byId('importJobs', jobId);
  if (!job || job.orgId !== orgId) throw new Error('Import job not found');
  try {
    store.update('importJobs', job.id, { status: 'processing', startedAt: new Date().toISOString() });
    const ext = path.extname(upload.originalname).toLowerCase();
    const archive = ext === '.zip' ? await parseArchive(upload.buffer) : { files: [{ name: upload.originalname, buffer: upload.buffer }], manifest: null };
    const inputFiles = archive.files;
    if (!inputFiles.length) throw new Error('The ZIP does not contain any files');
    if (archive.manifest && archive.manifest.files.length !== inputFiles.length) throw new Error('Package manifest file count does not match the ZIP contents');
    let recordCount = 0, valid = 0, warningCount = 0, errorCount = 0, duplicateCount = 0, documentCount = 0;
    const categories = {};
    for (const input of inputFiles) {
      const manifestItem = archive.manifest && archive.manifest.files.find(file => file && file.storedName === input.name);
      if (archive.manifest) {
        if (!manifestItem) throw new Error(`Package file is missing from the manifest: ${input.name}`);
        if (Number(manifestItem.size) !== input.buffer.length) throw new Error(`Package size verification failed: ${input.name}`);
        const digest = crypto.createHash('sha256').update(input.buffer).digest('hex');
        if (manifestItem.sha256 !== digest) throw new Error(`Package checksum verification failed: ${input.name}`);
      }
      const assigned = manifestTarget(archive.manifest, input.name);
      const inputExt = path.extname(input.name).toLowerCase();
      if ((assigned && assigned.kind === 'document') || !ALLOWED_EXTENSIONS.has(inputExt) || inputExt === '.zip') {
        const target = assigned || { kind: 'document', category: documentCategory(input.name, input.restricted) };
        stageDocument(job, orgId, input, target, manifestItem);
        categories.documents ||= { entity: 'documents', label: 'Client Documents', detected: 0, valid: 0, warnings: 0, errors: 0, duplicates: 0 };
        categories.documents.detected += 1; categories.documents.valid += 1; documentCount += 1; valid += 1;
        continue;
      }
      const datasets = await parseFile(input.name, input.buffer);
      for (const dataset of datasets) {
        const headers = [...new Set(dataset.rows.flatMap(row => Object.keys(row)))].slice(0, 250);
        const detection = detectEntity(headers);
        if (assigned && assigned.kind === 'business-data') {
          detection.entity = assigned.entity;
          detection.mappings = bestMapping(headers, defs[assigned.entity]);
          detection.confidence = Math.max(detection.confidence || 0, .9);
        }
        const file = store.insert('importFiles', {
          orgId, importJobId: job.id, filename: cleanText(dataset.sourceName, 300), size: input.buffer.length,
          type: path.extname(input.name).toLowerCase().slice(1), detectedEntity: detection.entity,
          confidence: detection.confidence, recordCount: dataset.rows.length, warning: dataset.warning || null
        });
        const mapping = store.insert('importMappings', {
          orgId, importJobId: job.id, importFileId: file.id, entity: detection.entity,
          columns: detection.mappings, confirmed: detection.mappings.every(item => !item.field || item.accepted)
        });
        if (detection.entity === 'unknown') {
          store.insert('importErrors', { orgId, importJobId: job.id, importFileId: file.id, severity: 'error', rowNumber: null, message: 'Business data type could not be detected' });
          errorCount += 1;
          continue;
        }
        categories[detection.entity] = categories[detection.entity] || { entity: detection.entity, label: defs[detection.entity].label, detected: 0, valid: 0, warnings: 0, errors: 0, duplicates: 0 };
        for (let index = 0; index < dataset.rows.length; index++) {
          const mapped = mappedRow(dataset.rows[index], mapping.columns);
          const validation = validateRow(detection.entity, mapped, defs[detection.entity], orgId);
          const rec = store.insert('importRecords', {
            orgId, importJobId: job.id, importFileId: file.id, rowNumber: index + 2, entity: detection.entity,
            raw: dataset.rows[index], mapped, valid: validation.errors.length === 0,
            errors: validation.errors, warnings: validation.warnings, duplicateId: validation.duplicateId,
            action: validation.duplicateId ? 'skip' : 'import'
          });
          recordCount += 1; categories[detection.entity].detected += 1;
          if (rec.valid) { valid += 1; categories[detection.entity].valid += 1; }
          if (rec.errors.length) { errorCount += rec.errors.length; categories[detection.entity].errors += rec.errors.length; }
          if (rec.warnings.length) { warningCount += rec.warnings.length; categories[detection.entity].warnings += rec.warnings.length; }
          if (rec.duplicateId) { duplicateCount += 1; categories[detection.entity].duplicates += 1; }
          for (const message of rec.errors) store.insert('importErrors', { orgId, importJobId: job.id, importFileId: file.id, importRecordId: rec.id, severity: 'error', rowNumber: rec.rowNumber, message });
          for (const message of rec.warnings) store.insert('importErrors', { orgId, importJobId: job.id, importFileId: file.id, importRecordId: rec.id, severity: 'warning', rowNumber: rec.rowNumber, message });
        }
      }
    }
    const status = errorCount ? 'ready_with_errors' : 'ready';
    return store.update('importJobs', job.id, {
      status, completedAnalysisAt: new Date().toISOString(),
      packageClient: archive.manifest?.client || null,
      packageId: archive.manifest?.packageId || null,
      summary: { files: inputFiles.length, documents: documentCount, records: recordCount, valid, warnings: warningCount, errors: errorCount, duplicates: duplicateCount, categories: Object.values(categories) }
    });
  } catch (error) {
    const staging = path.join(store.DATA_DIR, 'import-staging', job.id);
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    store.update('importJobs', job.id, { status: 'failed', error: cleanText(error.message, 500), failedAt: new Date().toISOString() });
    throw error;
  }
}

function findCustomer(orgId, value) {
  const key = normalize(value);
  return store.findOne('customers', item => item.orgId === orgId && [item.name, item.email, item.phone, item.gstin].some(candidate => normalize(candidate) === key));
}

function ensureCustomer(orgId, value, actorUserId, allowCreate) {
  let customer = findCustomer(orgId, value);
  if (!customer && allowCreate && cleanText(value)) customer = store.insert('customers', { orgId, name: cleanText(value, 200), phone: '', email: '', gstin: '', stateCode: '24', billingAddress: {}, shippingAddress: {}, creditLimit: 0, paymentTermsDays: 30, importedReference: true, createdBy: actorUserId });
  return customer;
}

function totalsFrom(row) {
  const grandTotal = r2(number(row.total || row.amount || row.value));
  const tax = r2(number(row.gst));
  const taxable = r2(number(row.subtotal) || Math.max(0, grandTotal - tax));
  return { subtotal: taxable, discountTotal: 0, taxable, cgst: 0, sgst: 0, igst: tax, grandTotal, roundOff: 0 };
}

function buildRecord(entity, row, context) {
  const common = { orgId: context.orgId, importedFromJobId: context.job.id, importedAt: new Date().toISOString() };
  if (entity === 'customers') return { collection: 'customers', value: { ...common, name: cleanText(row.name, 200), contactPerson: cleanText(row.contactPerson, 150), email: cleanText(row.email, 180), phone: cleanText(row.phone, 30), gstin: cleanText(row.gstin, 15).toUpperCase(), stateCode: cleanText(row.stateCode, 2) || context.org.stateCode || '24', billingAddress: { line1: cleanText(row.address, 300) }, shippingAddress: {}, creditLimit: number(row.creditLimit), paymentTermsDays: number(row.paymentTermsDays) || 30 } };
  if (entity === 'leads') return { collection: 'leads', value: { ...common, name: cleanText(row.name, 200), company: cleanText(row.company, 200), email: cleanText(row.email, 180), phone: cleanText(row.phone, 30), source: cleanText(row.source, 80) || 'import', status: ['new', 'contacted', 'qualified', 'converted', 'lost'].includes(normalize(row.status)) ? normalize(row.status) : 'new', value: number(row.value), productInterest: cleanText(row.productInterest, 250), owner: context.actorUserId } };
  if (entity === 'products') return { collection: 'products', value: { ...common, name: cleanText(row.name, 200), sku: cleanText(row.sku, 80) || `IMP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, hsn: cleanText(row.hsn, 20), uom: cleanText(row.uom, 20) || 'Nos', type: normalize(row.type) === 'service' ? 'service' : 'goods', category: cleanText(row.category, 100), purchasePrice: r2(number(row.purchasePrice)), salePrice: r2(number(row.salePrice)), gstRate: number(row.gstRate), minStock: number(row.minStock), openingQuantity: number(row.quantity) } };
  if (entity === 'suppliers') return { collection: 'suppliers', value: { ...common, name: cleanText(row.name, 200), phone: cleanText(row.phone, 30), email: cleanText(row.email, 180), gstin: cleanText(row.gstin, 15).toUpperCase(), address: cleanText(row.address, 400), paymentTermsDays: number(row.paymentTermsDays) || 30 } };
  if (entity === 'employees') return { collection: 'employees', value: { ...common, name: cleanText(row.name, 200), email: cleanText(row.email, 180), phone: cleanText(row.phone, 30), department: cleanText(row.department, 100), designation: cleanText(row.designation, 100), joiningDate: isoDate(row.joiningDate) || null, salary: r2(number(row.salary)), active: true } };
  const customer = ensureCustomer(context.orgId, row.customer, context.actorUserId, context.createMissingReferences);
  if (['invoices', 'quotations', 'payments', 'tickets', 'amc'].includes(entity) && !customer) throw new Error(`Customer reference not found: ${cleanText(row.customer, 100)}`);
  if (entity === 'invoices') {
    const totals = totalsFrom(row); const paid = Math.min(totals.grandTotal, number(row.paidAmount));
    return { collection: 'invoices', value: { ...common, number: cleanText(row.number, 80) || nextNumber(context.orgId, 'invoice'), customerId: customer.id, date: isoDate(row.date), dueDate: isoDate(row.dueDate) || isoDate(row.date), placeOfSupply: customer.stateCode || context.org.stateCode, status: paid >= totals.grandTotal ? 'paid' : (paid > 0 ? 'partial' : 'unpaid'), paidAmount: paid, lines: [{ productId: null, name: 'Imported historical invoice', hsn: '', uom: 'Nos', gstRate: 0, qty: 1, rate: totals.taxable, discountPct: 0, gross: totals.taxable, discount: 0, taxableValue: totals.taxable, cgst: 0, sgst: 0, igst: totals.igst, lineTotal: totals.grandTotal }], totals, sourceType: 'import', sourceId: context.job.id, notes: cleanText(row.notes, 2000), warehouseId: null } };
  }
  if (entity === 'quotations') { const totals = totalsFrom(row); return { collection: 'quotations', value: { ...common, number: cleanText(row.number, 80) || nextNumber(context.orgId, 'quotation'), customerId: customer.id, date: isoDate(row.date), validUntil: isoDate(row.validUntil) || null, placeOfSupply: customer.stateCode || context.org.stateCode, status: ['draft', 'sent', 'accepted', 'rejected', 'expired'].includes(normalize(row.status)) ? normalize(row.status) : 'draft', lines: [{ productId: null, name: 'Imported quotation', hsn: '', uom: 'Nos', gstRate: 0, qty: 1, rate: totals.taxable, lineTotal: totals.grandTotal }], totals, notes: cleanText(row.notes, 2000), convertedToId: null } }; }
  if (entity === 'payments') { const invoice = row.invoiceNumber ? store.findOne('invoices', item => item.orgId === context.orgId && normalize(item.number) === normalize(row.invoiceNumber)) : null; const amount = r2(number(row.amount)); return { collection: 'receipts', value: { ...common, number: cleanText(row.number, 80) || nextNumber(context.orgId, 'receipt'), date: isoDate(row.date), customerId: customer.id, amount, mode: ['cash', 'upi', 'bank', 'cheque', 'card'].includes(normalize(row.mode)) ? normalize(row.mode) : 'bank', reference: cleanText(row.reference, 150), allocations: invoice ? [{ invoiceId: invoice.id, amount }] : [] } }; }
  if (entity === 'expenses') return { collection: 'expenses', value: { ...common, number: cleanText(row.number, 80) || nextNumber(context.orgId, 'expense'), date: isoDate(row.date), category: cleanText(row.category, 100) || 'Imported', description: cleanText(row.description, 500), amount: r2(number(row.amount)), vendor: cleanText(row.vendor, 200), mode: cleanText(row.mode, 50), status: ['approved', 'rejected', 'pending'].includes(normalize(row.status)) ? normalize(row.status) : 'approved', submittedBy: context.actorUserId } };
  if (entity === 'tickets') return { collection: 'tickets', value: { ...common, number: cleanText(row.number, 80) || nextNumber(context.orgId, 'ticket'), customerId: customer.id, subject: cleanText(row.subject, 250), description: cleanText(row.description, 2000), priority: ['low', 'medium', 'high', 'urgent'].includes(normalize(row.priority)) ? normalize(row.priority) : 'medium', status: ['open', 'assigned', 'in_progress', 'waiting_parts', 'waiting_customer', 'resolved', 'closed'].includes(normalize(row.status)) ? normalize(row.status) : 'open', openedAt: isoDate(row.date) || new Date().toISOString().slice(0, 10) } };
  if (entity === 'amc') return { collection: 'amcContracts', value: { ...common, number: cleanText(row.number, 80) || nextNumber(context.orgId, 'amc'), customerId: customer.id, assetDesc: cleanText(row.asset, 300) || 'Imported AMC asset', startDate: isoDate(row.startDate) || new Date().toISOString().slice(0, 10), endDate: isoDate(row.endDate), value: r2(number(row.value)), visitsAllowed: number(row.visitsAllowed), visitsUsed: 0, status: ['active', 'expired', 'cancelled', 'renewed'].includes(normalize(row.status)) ? normalize(row.status) : 'active', reminderDays: [30, 7] } };
  throw new Error(`Import type is not supported: ${entity}`);
}

function updateDuplicate(collection, id, value) {
  const safe = { ...value };
  delete safe.orgId; delete safe.importedFromJobId; delete safe.importedAt; delete safe.openingQuantity;
  return store.update(collection, id, safe);
}

function confirmImport(job, options, actor, org) {
  if (!['ready', 'ready_with_errors'].includes(job.status)) throw new Error('Import is not ready for confirmation');
  const decisions = options.decisions || {};
  const selected = new Set(Array.isArray(options.recordIds) ? options.recordIds : []);
  const records = store.find('importRecords', item => item.orgId === org.id && item.importJobId === job.id)
    .filter(item => !selected.size || selected.has(item.id))
    .sort((a, b) => ['customers', 'suppliers', 'products', 'leads', 'invoices', 'quotations', 'payments', 'expenses', 'employees', 'tickets', 'amc'].indexOf(a.entity) - ['customers', 'suppliers', 'products', 'leads', 'invoices', 'quotations', 'payments', 'expenses', 'employees', 'tickets', 'amc'].indexOf(b.entity));
  const rollbackPlan = { inserted: [], updated: [] };
  let imported = 0, skipped = 0, failed = 0;
  const failures = [];
  for (const file of store.find('importFiles', item => item.orgId === org.id && item.importJobId === job.id && item.kind === 'document' && item.stagedPath)) {
    try {
      if (!fs.existsSync(file.stagedPath)) throw new Error(`Staged document is unavailable: ${file.filename}`);
      const dir = path.join(store.DATA_DIR, 'documents', org.id);
      fs.mkdirSync(dir, { recursive: true });
      const storedPath = path.join(dir, `${file.id}.bin`);
      fs.renameSync(file.stagedPath, storedPath);
      const document = store.insert('clientDocuments', {
        orgId: org.id, importJobId: job.id, importFileId: file.id, clientName: cleanText(job.packageClient?.name, 200),
        clientReference: cleanText(job.packageClient?.reference, 120), filename: file.filename, category: file.documentCategory || 'general',
        size: file.size, type: file.type, restricted: file.restricted === true, sourceHash: file.sourceHash, storedPath,
        uploadedBy: actor.id
      });
      rollbackPlan.inserted.push({ collection: 'clientDocuments', id: document.id });
      store.update('importFiles', file.id, { stagedPath: null, documentId: document.id, importStatus: 'imported' });
      imported += 1;
    } catch (error) { failed += 1; failures.push({ fileId: file.id, message: cleanText(error.message, 300) }); }
  }
  for (const record of records) {
    const action = decisions[record.id] || record.action || (record.duplicateId ? 'skip' : 'import');
    if (!record.valid || action === 'skip') { skipped += 1; continue; }
    try {
      const built = buildRecord(record.entity, record.mapped, { orgId: org.id, org, actorUserId: actor.id, job, createMissingReferences: options.createMissingReferences === true });
      let saved;
      if (record.duplicateId && action === 'merge') {
        const before = store.byId(built.collection, record.duplicateId);
        if (!before || before.orgId !== org.id) throw new Error('Duplicate target is no longer available');
        rollbackPlan.updated.push({ collection: built.collection, id: before.id, before: JSON.parse(JSON.stringify(before)) });
        saved = updateDuplicate(built.collection, before.id, built.value);
      } else {
        saved = store.insert(built.collection, built.value);
        rollbackPlan.inserted.push({ collection: built.collection, id: saved.id });
      }
      if (record.entity === 'products' && built.value.openingQuantity && saved.type !== 'service') {
        const warehouse = store.findOne('warehouses', item => item.orgId === org.id);
        if (warehouse) {
          const entry = postStock({ orgId: org.id, productId: saved.id, warehouseId: warehouse.id, type: 'opening_import', qty: built.value.openingQuantity, rate: built.value.purchasePrice, refType: 'import', refId: job.id, refNumber: job.number, note: 'Opening stock from Smart Data Import' });
          rollbackPlan.inserted.push({ collection: 'stockLedger', id: entry.id });
        }
      }
      store.update('importRecords', record.id, { action, importStatus: 'imported', importedRecordId: saved.id });
      imported += 1;
    } catch (error) {
      failed += 1; failures.push({ recordId: record.id, rowNumber: record.rowNumber, message: cleanText(error.message, 300) });
      store.update('importRecords', record.id, { importStatus: 'failed', importError: cleanText(error.message, 300) });
    }
  }
  const status = failed ? (imported ? 'completed_with_warnings' : 'failed') : 'completed';
  const updated = store.update('importJobs', job.id, { status, importedAt: new Date().toISOString(), importedBy: actor.id, importSummary: { selected: records.length, imported, skipped, failed }, rollbackPlan, failures });
  audit(org.id, actor.id, 'confirm_import', 'import_job', job.id, updated.importSummary);
  return updated;
}

function rollbackImport(job, actor, org) {
  if (!['completed', 'completed_with_warnings'].includes(job.status) || !job.rollbackPlan || job.rolledBackAt) throw new Error('This import cannot be rolled back');
  for (const item of [...(job.rollbackPlan.inserted || [])].reverse()) {
    const record = store.byId(item.collection, item.id);
    if (record && record.orgId === org.id && record.importedFromJobId && record.importedFromJobId !== job.id) throw new Error('Rollback stopped because an imported record was changed by another import');
    if (record && record.orgId === org.id) {
      if (item.collection === 'clientDocuments' && record.storedPath && fs.existsSync(record.storedPath)) fs.unlinkSync(record.storedPath);
      store.remove(item.collection, item.id);
    }
  }
  for (const item of [...(job.rollbackPlan.updated || [])].reverse()) {
    const current = store.byId(item.collection, item.id);
    if (current && current.orgId === org.id) {
      Object.keys(current).forEach(key => delete current[key]); Object.assign(current, item.before); store.save(item.collection);
    }
  }
  const updated = store.update('importJobs', job.id, { status: 'rolled_back', rolledBackAt: new Date().toISOString(), rolledBackBy: actor.id });
  audit(org.id, actor.id, 'rollback_import', 'import_job', job.id, { inserted: job.rollbackPlan.inserted.length, updated: job.rollbackPlan.updated.length });
  return updated;
}

function csvCell(value) {
  let text = String(value == null ? '' : value).replace(/\r?\n/g, ' ');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function errorCsv(job, orgId) {
  const errors = store.find('importErrors', item => item.orgId === orgId && item.importJobId === job.id);
  return ['Severity,File,Row,Message', ...errors.map(item => {
    const file = store.byId('importFiles', item.importFileId);
    return [item.severity, file ? file.filename : '', item.rowNumber || '', item.message].map(csvCell).join(',');
  })].join('\r\n');
}

module.exports = { defs, ALLOWED_EXTENSIONS, DOCUMENT_CATEGORIES, PACKAGE_MANIFEST, analyseUpload, confirmImport, rollbackImport, errorCsv, bestMapping, detectEntity, mappedRow, validateRow, classifyPackageFile, documentCategory };
