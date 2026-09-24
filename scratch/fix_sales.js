const fs = require('fs');
const path = require('path');
const sFile = path.join(__dirname, '..', 'src', 'routes', 'sales.js');
let sCode = fs.readFileSync(sFile, 'utf8');

sCode = sCode.replace(
  "const { fileStorage } = require('../../plugins/storage');",
  "const fileStorage = require('../services/file-storage');"
);

fs.writeFileSync(sFile, sCode);
