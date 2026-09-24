const fs = require('fs');
const path = require('path');
const uiFile = path.join(__dirname, '..', 'public', 'js', 'pages-commerce.js');
let uiCode = fs.readFileSync(uiFile, 'utf8');

uiCode = uiCode.replace(
  "extraHTML += '<h4>Associated BOMs</h4><p class=\"muted\">No BOMs linked.</p>';",
  "extraHTML += '<h4>Associated BOMs</h4><p class=\"muted\">No BOMs linked.</p>';\n    }\n    if (Core.can('manufacturing', 'create')) {\n      extraHTML += `<button type=\"button\" class=\"btn btn-outline btn-sm\" style=\"margin-top:8px\" onclick=\"Core.closeModal(); setTimeout(() => { location.hash = '#/manufacturing/boms'; Pages.openBomForm('\${soId}'); }, 300)\">+ Create BOM for this Order</button>`;"
);

fs.writeFileSync(uiFile, uiCode);
