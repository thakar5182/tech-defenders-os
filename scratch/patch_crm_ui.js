const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'js', 'pages-core.js');
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  "    <div class=\"card customer-notes\" style=\"margin-top:16px\"><div class=\"card-head\"><div><h3>Notes</h3></div>${Core.can('crm', 'edit') ? `<button class=\"btn btn-outline btn-sm\" onclick=\"Pages.openNoteForm('${c.id}')\">+ Add Note</button>` : ''}</div>\n      ${d.notes && d.notes.length ? `<ul class=\"timeline\" style=\"padding:16px 20px\">${d.notes.map(n => `<li><b>${Core.esc(n.userName)}</b> <small>${Core.fmtDate(n.createdAt)}</small><p style=\"margin-top:4px\">${Core.esc(n.text)}</p>\n      ${n.attachment ? `<div style=\"margin-top:8px\"><a class=\"btn btn-outline btn-sm\" href=\"/api/crm/customers/${c.id}/notes/${n.id}/attachment\" target=\"_blank\">📎 ${Core.esc(n.attachment.title)}</a></div>` : ''}\n      <div style=\"margin-top:4px\">${Core.can('crm', 'edit') ? `<button class=\"btn btn-ghost btn-sm\" onclick=\"Pages.openNoteForm('${c.id}', '${n.id}')\">Edit</button> <button class=\"btn btn-ghost btn-sm\" onclick=\"Pages.deleteNote('${c.id}', '${n.id}')\">Delete</button>` : ''}</div></li>`).join('')}</ul>` : '<div class=\"empty-state\">No notes added.</div>'}\n    </div>",
  `    <div class="card customer-notes" style="margin-top:16px"><div class="card-head"><div><h3>Notes</h3></div>\${Core.can('crm', 'edit') ? \`<button class="btn btn-outline btn-sm" onclick="Pages.openNoteForm('\${c.id}')">+ Add Note</button>\` : ''}</div>
      \${d.notes && d.notes.length ? \`<ul class="timeline" style="padding:16px 20px">\${d.notes.map(n => \`<li><b>\${Core.esc(n.userName)}</b> <small>\${Core.fmtDate(n.createdAt)}</small><p style="margin-top:4px">\${Core.esc(n.text)}</p>
      \${n.attachment ? \`<div style="margin-top:8px"><a class="btn btn-outline btn-sm" href="/api/crm/customers/\${c.id}/notes/\${n.id}/attachment" target="_blank">📎 \${Core.esc(n.attachment.title)}</a></div>\` : ''}
      <div style="margin-top:4px">\${Core.can('crm', 'edit') ? \`<button class="btn btn-ghost btn-sm" onclick="Pages.openNoteForm('\${c.id}', '\${n.id}')">Edit</button> <button class="btn btn-ghost btn-sm" onclick="Pages.deleteNote('\${c.id}', '\${n.id}')">Delete</button>\` : ''}</div></li>\`).join('')}</ul>\` : '<div class="empty-state">No notes added.</div>'}
    </div>

    <div class="card" style="margin-top:16px"><div class="card-head"><h3>Product Sales History</h3></div>
      \${d.productSales && d.productSales.length ? Core.table([{label:'Invoice',render:r=>'<b>'+Core.esc(r.number)+'</b>'},{label:'Date',render:r=>Core.fmtDate(r.date)},{label:'Amount',num:true,render:r=>Core.money(r.total)},{label:'Status',render:r=>Core.badge(r.status)}], d.productSales) : '<div class="empty-state">No product sales yet.</div>'}
    </div>
    
    <div class="card" style="margin-top:16px"><div class="card-head"><h3>Sales Visits</h3>\${Core.can('sales', 'create') ? \`<button class="btn btn-outline btn-sm" onclick="location.hash='#/sales/visits/new'">+ Add Visit</button>\` : ''}</div>
      \${d.salesVisits && d.salesVisits.length ? Core.table([{label:'Date',render:r=>Core.fmtDate(r.date)},{label:'Purpose',key:'purpose'},{label:'Outcome',key:'outcome'},{label:'Status',render:r=>Core.badge(r.status)}], d.salesVisits) : '<div class="empty-state">No sales visits recorded.</div>'}
    </div>`
);

fs.writeFileSync(file, code);
