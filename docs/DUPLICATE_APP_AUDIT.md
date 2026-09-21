# Duplicate application audit

Date: 2026-09-21

## Scope and method

This audit traces the complete `APP_CATALOG`, sidebar navigation, every `Core.route` registration, server router mount, route-level store access, shared services, permission checks, dashboard links and test coverage. Similar names were not treated as proof of duplication.

The catalog contains 96 unique permission-controlled apps. Before cleanup the sidebar contained 107 registrations for those 96 apps: nine accidental exact repeats and two intentional secondary entry points (`All Apps` and `My Data Backup`). The cleanup removes only the nine exact repeats.

## Backend and storage profiles

The profile codes below keep the per-app inventory readable. A profile identifies the API family and principal persisted collections/services used by the app.

| Code | API / router | Principal collections and services |
|---|---|---|
| D | `/api/dashboard`, `/api/subscription`, `/api/backups` | dashboard aggregates; organizations, subscriptions; backup policies/snapshots/restore requests; backup service |
| CRM | `/api/crm`, `/api/customer-tools` | leads, customers, contacts, deals, tasks, meetings, activities, invoices, receipts, portal access |
| EC | `/api/enterprise-controls` | segments, assignment rules, sequences, recurring profiles, matching reviews, MRP, dispatch, service logs |
| S | `/api/sales`, `/api/collections`, `/api/sales-operations` | quotations, orders, invoices, receipts, credit notes, stock ledger, visits, dispatches, gate passes |
| P | `/api/purchase`, `/api/v3` | suppliers, requisitions, RFQs, purchase orders, GRNs, purchase invoices/returns/payments |
| I | `/api/inventory`, `/api/inventory-controls` | products, warehouses, ledger, reservations, lots, serials, inspections, bins, transfers, assets |
| M | `/api/manufacturing`, `/api/enterprise-controls` | BOMs, job orders, routings, work centres, MRP runs, products and stock ledger |
| SV | `/api/service`, `/api/enterprise-controls` | AMC contracts, tickets, SLA policies, dispatches, visits, media, signatures, time logs, knowledge articles |
| F | `/api/finance`, `/api/finance-controls`, `/api/finance-production`, `/api/v3` | accounts, journals, expenses, bank records, GST, periods, balances, adjustments, TDS, ledgers |
| HR | `/api/p0` | employees, attendance, shifts, salary components/structures, payroll policies/runs, payslips, leave requests |
| PJ | `/api/p0` | projects, milestones, work orders, timesheets, customers, invoices and profitability aggregates |
| O | `/api/p0` | tasks, approvals, mentions, notifications, tickets, audit events |
| R | `/api/reports`, `/api/report-controls`, `/api/business-hub` | report aggregates, saved reports, custom reports, schedules/runs, operational source collections |
| C | `/api/ops`, `/api/business-hub` | email queue/campaigns/templates, communication logs, deliveries, consent, segments, inbound history |
| A | `/api/ops` | automation rules/executions, background import and communication services |
| DI | `/api/ops` | import jobs/files/mappings/records/errors and client documents |
| AD | `/api/admin`, `/api/security`, `/api/integrations`, `/api/business-hub`, `/api/subscription` | users, organizations, sessions, security/audit events, integrations, API keys/webhooks/logs, subscriptions |
| AI | `/api/ai-command` | conversations/action requests plus permission-filtered operational records |
| B2B | `/api/business-hub` | catalogues, contract prices, commerce orders, products, customers and sales orders |

## Complete app inventory

`Nav/active = yes` means the app is permission-catalogued, linked by the sidebar and has a registered renderer. File paths are relative to the repository root.

| App | Route | Frontend implementation | Profile | Nav/active | Same-purpose finding |
|---|---|---|---|---|---|
| Dashboard | `#/dashboard` | `public/js/pages-core.js` | D | yes/yes | unique aggregate |
| AI Command Centre | `#/ai/command-centre` | `public/js/pages-ai-command.js` | AI | yes/yes | exact sidebar repeat removed |
| My Plan | `#/my-plan` | `public/js/pages-my-plan.js` | D | yes/yes | unique self-service plan view |
| All Apps | `#/apps` | `public/js/pages-onboarding.js` | D | yes/yes | two intentional entry points kept |
| Get Started | `#/onboarding` | `public/js/pages-onboarding.js` | D | yes/yes | unique onboarding |
| My Data Backup | `#/my-backup` | `public/js/pages-backups.js` | D | yes/yes | two intentional entry points kept |
| Customer Intelligence | `#/crm/intelligence` | `public/js/pages-enterprise-controls.js` | EC | yes/yes | route collision; see manual decisions |
| Sales Automation | `#/crm/automation` | `public/js/pages-enterprise-controls.js` | EC | yes/yes | unique rules/sequences |
| Leads | `#/crm/leads` | `public/js/pages-core.js` | CRM | yes/yes | unique lead workflow |
| Customers | `#/crm/customers` | `public/js/pages-core.js` | CRM | yes/yes | unique customer master |
| Contacts | `#/crm/contacts` | `public/js/pages-core.js` | CRM | yes/yes | unique contact master |
| Deals Pipeline | `#/crm/deals` | `public/js/pages-core.js` | CRM | yes/yes | unique opportunity workflow |
| Tasks & Follow-ups | `#/crm/tasks` | `public/js/pages-core.js` | CRM | yes/yes | CRM-specific, not Operations Inbox |
| Meetings | `#/crm/meetings` | `public/js/pages-core.js` | CRM | yes/yes | unique meeting records |
| Daily Work Centre | `#/crm/daily-work` | `public/js/pages-core.js` | CRM | yes/yes | CRM work aggregation |
| Late Payments | `#/crm/late-payments` | `public/js/pages-core.js` | CRM | yes/yes | customer collection view, not banking |
| Recurring & Payments | `#/sales/recurring` | `public/js/pages-enterprise-controls.js` | EC | yes/yes | exact sidebar repeat removed |
| Quotations | `#/sales/quotations` | `public/js/pages-commerce.js` | S | yes/yes | unique quote lifecycle |
| AI Quote Draft | `#/sales/ai-quote` | `public/js/pages-advanced.js` | S | yes/yes | draft helper, not quotation master |
| Sales Documents | `#/sales/documents` | `public/js/pages-advanced.js` | S | yes/yes | proforma/challan/debit-note workflows |
| Sales Orders | `#/sales/orders` | `public/js/pages-commerce.js` | S | yes/yes | unique order stage |
| GST Invoices | `#/sales/invoices` | `public/js/pages-commerce.js` | S | yes/yes | unique invoice stage |
| Receipts | `#/sales/receipts` | `public/js/pages-commerce.js` | S | yes/yes | unique customer payments |
| Credit Notes | `#/sales/credit-notes` | `public/js/pages-commerce.js` | S | yes/yes | unique sales adjustment |
| Sales Visits | `#/sales/visits` | `public/js/pages-sales-operations.js` | S | yes/yes | unique field activity |
| Dispatch | `#/sales/dispatches` | `public/js/pages-sales-operations.js` | S | yes/yes | sales dispatch, not service dispatch |
| Gate Passes | `#/sales/gate-passes` | `public/js/pages-sales-operations.js` | S | yes/yes | unique movement control |
| Collections Centre | `#/sales/collections` | `public/js/pages-collection-controls.js` | S | yes/yes | receivables action centre |
| B2B Commerce | `#/sales/b2b-commerce` | `public/js/pages-business-hub.js` | B2B | yes/yes | exact sidebar repeat removed |
| Requisitions | `#/purchase/requisitions` | `public/js/pages-commerce.js` | P | yes/yes | unique purchase request stage |
| RFQs & Quotes | `#/purchase/rfqs` | `public/js/pages-commerce.js` | P | yes/yes | unique sourcing stage |
| Purchase Orders | `#/purchase/orders` | `public/js/pages-commerce.js` | P | yes/yes | unique order stage |
| GRN / Receipts | `#/purchase/grns` | `public/js/pages-commerce.js` | P | yes/yes | goods receipt, not sales receipt |
| Suppliers | `#/purchase/suppliers` | `public/js/pages-commerce.js` | P | yes/yes | unique supplier master/portal access |
| Vendor Billing | `#/purchase/billing` | `public/js/pages-advanced.js` | P | yes/yes | invoice/payment workflow |
| 3-Way Match & Landed Cost | `#/purchase/matching` | `public/js/pages-enterprise-controls.js` | EC | yes/yes | exact sidebar repeat removed |
| Products | `#/inventory/products` | `public/js/pages-commerce.js` | I | yes/yes | unique product master |
| Stock Summary | `#/inventory/summary` | `public/js/pages-commerce.js` | I | yes/yes | aggregate, not ledger duplicate |
| Stock Ledger | `#/inventory/ledger` | `public/js/pages-commerce.js` | I | yes/yes | transaction history |
| Reservations | `#/inventory/reservations` | `public/js/pages-advanced.js` | I | yes/yes | unique allocation workflow |
| Price Lists | `#/inventory/price-lists` | `public/js/pages-inventory-controls.js` | I | yes/yes | unique pricing master |
| Assets | `#/inventory/assets` | `public/js/pages-inventory-controls.js` | I | yes/yes | asset register, not stock master |
| Damage / Loss | `#/inventory/damage-loss` | `public/js/pages-inventory-controls.js` | I | yes/yes | unique incident workflow |
| Quality & Traceability | `#/inventory/quality` | `public/js/pages-inventory-controls.js` | I | yes/yes | lots/serials/inspection/NCR |
| Warehouse Operations | `#/inventory/warehouse-operations` | `public/js/pages-inventory-controls.js` | I | yes/yes | bins/counts/transfers/reorder |
| MRP & Work Centres | `#/manufacturing/planning` | `public/js/pages-enterprise-controls.js` | M | yes/yes | exact sidebar repeat removed |
| BOMs | `#/manufacturing/boms` | `public/js/pages-ops.js` | M | yes/yes | unique manufacturing master |
| Job Orders | `#/manufacturing/jobs` | `public/js/pages-ops.js` | M | yes/yes | unique production execution |
| Dispatch & Knowledge | `#/service/dispatch` | `public/js/pages-enterprise-controls.js` | SV | yes/yes | exact repeat removed; distinct from sales dispatch |
| AMC Contracts | `#/service/amc` | `public/js/pages-ops.js` | SV | yes/yes | unique contract workflow |
| Service Tickets | `#/service/tickets` | `public/js/pages-ops.js` | SV | yes/yes | unique service cases |
| SLA & Technician Control | `#/service/sla-control` | `public/js/pages-service-sla.js` | SV | yes/yes | SLA policy/control view |
| Chart of Accounts | `#/finance/accounts` | `public/js/pages-ops.js` | F | yes/yes | unique account master |
| Journal Entries | `#/finance/journals` | `public/js/pages-ops.js` | F | yes/yes | unique postings |
| Expenses | `#/finance/expenses` | `public/js/pages-ops.js` | F | yes/yes | unique expense workflow |
| Banking & Reconciliation | `#/finance/banking` | `public/js/pages-finance-controls.js` | F | yes/yes | unique bank matching |
| Finance Production Controls | `#/finance/production-controls` | `public/js/pages-finance-controls.js` | F | yes/yes | periods, balances, GST/TDS |
| Petty Cash | `#/finance/petty-cash` | `public/js/pages-finance-controls.js` | F | yes/yes | unique cashbook |
| Cost Centres | `#/finance/cost-centers` | `public/js/pages-finance-controls.js` | F | yes/yes | unique allocation master |
| Cheque Status | `#/finance/cheques` | `public/js/pages-finance-controls.js` | F | yes/yes | unique cheque register |
| GST Dashboard | `#/finance/gst-dashboard` | `public/js/pages-finance-controls.js` | F | yes/yes | tax view, not invoice duplicate |
| Profit & Loss | `#/finance/pnl` | `public/js/pages-ops.js` | F | yes/yes | unique statement |
| Ledgers & Statements | `#/finance/ledgers` | `public/js/pages-advanced.js` | F | yes/yes | GL/balance sheet/cash flow |
| Employees | `#/hr/employees` | `public/js/pages-ops.js` | HR | yes/yes | unique employee master |
| Attendance | `#/hr/attendance` | `public/js/pages-p0.js` | HR | yes/yes | unique clock/shift workflow |
| Payroll & Payslips | `#/hr/payroll` | `public/js/pages-p0.js` | HR | yes/yes | unique payroll workflow |
| Leave Requests | `#/hr/leaves` | `public/js/pages-ops.js` | HR | yes/yes | unique leave workflow |
| Projects & Work Orders | `#/projects/board` | `public/js/pages-p0.js` | PJ | yes/yes | unique project delivery workflow |
| Operations Inbox | `#/operations/inbox` | `public/js/pages-p0.js` | O | yes/yes | cross-module work queue |
| Report Builder | `#/reports/builder` | `public/js/pages-business-hub.js` | R | yes/yes | exact repeat removed; builder is unique |
| Reports Command Centre | `#/reports/command` | `public/js/pages-report-controls.js` | R | yes/yes | scheduling/drill-down, not builder |
| Sales Report | `#/reports/sales` | `public/js/pages-ops.js` | R | yes/yes | unique preset |
| Receivables | `#/reports/receivables` | `public/js/pages-ops.js` | R | yes/yes | unique preset |
| Stock Report | `#/reports/stock` | `public/js/pages-ops.js` | R | yes/yes | unique preset |
| Lead Funnel | `#/reports/funnel` | `public/js/pages-ops.js` | R | yes/yes | unique preset |
| Service Report | `#/reports/service` | `public/js/pages-ops.js` | R | yes/yes | unique preset |
| Consent & Segmentation | `#/communication/governance` | `public/js/pages-business-hub.js` | C | yes/yes | exact sidebar repeat removed |
| Email Centre | `#/communication/email` | `public/js/pages-operations.js` | C | yes/yes | outbound composer/campaigns |
| Communication History | `#/communication/history` | `public/js/pages-operations.js` | C | yes/yes | message timeline |
| Delivery Analytics | `#/communication/analytics` | `public/js/pages-operations.js` | C | yes/yes | delivery aggregate |
| Automation Builder | `#/automation/builder` | `public/js/pages-operations.js` | A | yes/yes | unique rules/execution history |
| Data Package Studio | `#/data-package` | `public/js/pages-operations.js` | DI | yes/yes | package import/export workflow |
| Import Centre | `#/data-import` | `public/js/pages-operations.js` | DI | yes/yes | mapped record import workflow |
| Client Documents | `#/client-documents` | `public/js/pages-operations.js` | DI | yes/yes | document repository |
| API & Integration Hub | `#/admin/api-hub` | `public/js/pages-business-hub.js` | AD | yes/yes | exact sidebar repeat removed |
| Security Centre | `#/admin/security` | `public/js/pages-ops.js` | AD | yes/yes | sessions/security events |
| Plan & Subscription | `#/admin/subscription` | `public/js/pages-subscription.js` | AD | yes/yes | tenant self-service view |
| Subscription Manager | `#/admin/subscription-manager` | `public/js/pages-subscription-manager.js` | AD | yes/yes | admin lifecycle controls, not duplicate |
| Platform Control | `#/admin/platform` | `public/js/pages-ops.js` | AD | yes/yes | Super Admin cross-tenant control |
| Users & Roles | `#/admin/users` | `public/js/pages-ops.js` | AD | yes/yes | tenant account/access management |
| Approval Center | `#/admin/approvals` | `public/js/pages-advanced.js` | AD | yes/yes | governed approvals |
| Live Integrations | `#/admin/integrations` | `public/js/pages-advanced.js` | AD | yes/yes | provider connection status |
| Branches | `#/admin/branches` | `public/js/pages-advanced.js` | AD | yes/yes | branch master |
| Company Settings | `#/admin/settings` | `public/js/pages-ops.js` | AD | yes/yes | organization settings |
| Numbering Series | `#/admin/sequences` | `public/js/pages-ops.js` | AD | yes/yes | sequence configuration |
| Audit Log | `#/admin/audit` | `public/js/pages-ops.js` | AD | yes/yes | append-only audit view |

## Duplicate groups cleaned

| Duplicate group | Canonical app kept | Redundant registration removed | Reason |
|---|---|---|---|
| AI command navigation | `#/ai/command-centre` | 1 identical sidebar object | same route, label, icon and permission module |
| Recurring sales navigation | `#/sales/recurring` | 1 identical sidebar object | exact adjacent repeat |
| Purchase matching navigation | `#/purchase/matching` | 1 identical sidebar object | exact adjacent repeat |
| Manufacturing planning navigation | `#/manufacturing/planning` | 1 identical sidebar object | exact adjacent repeat |
| Service dispatch navigation | `#/service/dispatch` | 1 identical sidebar object | exact adjacent repeat |
| Report builder navigation | `#/reports/builder` | 1 identical sidebar object | exact adjacent repeat |
| Communication governance navigation | `#/communication/governance` | 1 identical sidebar object | exact adjacent repeat |
| API hub navigation | `#/admin/api-hub` | 1 identical sidebar object | exact repeated object in same group |
| B2B commerce navigation | `#/sales/b2b-commerce` | 1 identical sidebar object | exact repeated object in same group |

No component, route, API, database collection or service was deleted: every implementation was either canonical, shared, or contained distinct functionality.

## Potential duplicates requiring manual decision

1. `crm/intelligence` is registered by both `pages-advanced.js` (lead scoring/import/merge using `/api/v3/crm/lead-insights`) and `pages-enterprise-controls.js` (customer health and segmentation using `/api/enterprise-controls/crm/intelligence`). The later-loaded customer implementation is the active navigation target, but the lead implementation has unique capabilities. Deleting either would lose functionality; route separation is a product decision and is outside this cleanup.
2. `All Apps` is exposed in Overview and its own sidebar group. Both point to one implementation and appear intentional for discoverability.
3. `My Data Backup` is exposed in Overview and Backup & Restore. Both point to one implementation and appear intentional for quick access.
4. Plan & Subscription and Subscription Manager share subscription data but serve tenant self-service versus administrator lifecycle management.
5. Report Builder and Reports Command Centre share reporting sources but provide authoring versus scheduling/drill-down.

## Validation

- JavaScript syntax check: passed for the modified file.
- Whitespace/error check: passed (`git diff --check`).
- Full test command: passed (`npm test`).
- Test suites passed: smoke, v3, integrations, operations, P0, P1 portal, banking, quality, enterprise controls, business hub, AI command, persistence and Google authentication.
- Type-check script: not defined by this JavaScript project.
- Lint script: not defined by this project.
- Build script: not defined; the application serves static browser JavaScript and Node routes directly.

## Final statistics

- Unique permission-controlled apps before cleanup: 96
- Sidebar registrations before cleanup: 107
- Proven redundant registrations detected and removed: 9
- Intentional repeated entry points preserved: 2
- Unique apps remaining: 96
- Frontend route registrations: 104 registrations / 103 route keys
- Potential duplicate route requiring manual decision: 1
- Routes removed: 0
- Files deleted: 0
- APIs removed: 0
- Database changes: 0
