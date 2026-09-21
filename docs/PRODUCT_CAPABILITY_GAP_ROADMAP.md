# Tech Defenders OS capability gap roadmap

Date: 2026-09-21

This roadmap is based on the complete 96-app inventory in `DUPLICATE_APP_AUDIT.md`. Classification follows the requested rule: **A existing, B partial/extend, C genuinely new, D manual review**. A feature marked A is not recreated.

## Existing capability map

- CRM: leads, contacts, customers, deals, activities, tasks, meetings, late payments, customer intelligence, segmentation, assignments, duplicate merge, follow-up sequences.
- Sales: quotations/versioning, orders, invoices, recurring billing, receipts, credit notes, payment links, collections, dispatch, gate passes, RMA, targets and commissions.
- Finance: accounts, journals, expenses, ledgers, P&L, balance sheet/cash flow, banking/reconciliation, GST, TDS, periods, opening balances and adjustments.
- Purchase: suppliers, requisitions, RFQs, purchase orders, GRNs, vendor billing/payments, 3-way matching, landed cost and supplier performance.
- Inventory: products/categories, warehouses, stock ledger/summary, reservations, price lists, assets, incidents, lots/serials, quality, bins, counts, transfers and reorder recommendations.
- Manufacturing: BOMs, jobs, work centres, routings and MRP.
- Service: AMC contracts, tickets, SLA, dispatch, visits, technician time, service media/signatures, escalations and knowledge articles.
- HR: employees, attendance, shifts, leave, salary structures/components, statutory payroll, adjustments, payslips, bank sheet and accounting posting/reversal.
- Projects: projects, milestones, work orders, timesheets, costing and profitability.
- Communication/marketing: templates, email campaigns, queue, delivery analytics, consent, segments, suppression, inbound timeline and WhatsApp architecture.
- Automation: triggers, conditions, actions, execution history and scheduled background jobs.
- Reports: governed custom builder, presets, command centre, schedules, runs, exports and operational drill-down sources.
- Portals: customer/supplier access, quotations, invoices/PDFs, payment links, tickets/conversation, project progress, RFQ response, PO acceptance and secure documents.
- Administration/security: users, roles, app/module permission matrix, branches, settings, sequences, sessions/devices, security events, API keys, webhooks, API logs, subscriptions, backups and audit chain.
- AI: one permission-aware command centre, conversations, recommendations and human-approved actions.

## Gap classification by requested product area

| Area | A — reuse | B — extend existing | C — genuinely new | D — manual review |
|---|---|---|---|---|
| CRM | lead/contact/customer/deal/task/meeting/intelligence/automation | territories, richer email tracking, relationship signals | none needs a separate module | lead-vs-customer intelligence route collision |
| Sales | quote/order/invoice/recurring/credit/payment/targets/commission | coupons, renewal forecasting, approval depth | none | product catalog belongs to Inventory, not a second Sales catalog |
| Finance | full core accounting, bank, GST/TDS, periods | budgets, recurring expenses, stronger statutory exports | budget control inside Finance | income app would duplicate journals/receipts |
| Inventory | stock, transfers, serial/lot, quality, alerts, valuation sources | mobile scanning, forecasting depth | none | purchase/vendor features stay in Purchase |
| Purchase | end-to-end procure-to-pay and portal | contracts, rating rules and analytics | vendor contract register | supplier/vendor naming merge needs product decision |
| HR | employee/attendance/leave/payroll | departments, designations, holidays, recruitment, performance, training | workforce lifecycle records added in Release 1 | separate Employee Portal could duplicate existing self-service routes |
| Projects | milestones/work orders/time/cost/profit | subtasks, dependencies, templates, Gantt, workload | none; extend Projects board | project tasks vs CRM tasks need shared-task design |
| Help desk | tickets/SLA/assignment/escalation/KB/portal | categories, canned replies, internal notes, CSAT, automation depth | none | Service Tickets and Help Desk must remain one system |
| AMC/service | contracts, dispatch, visits, technician logs, signatures/media | schedules, checklists, asset history, renewals, invoice automation | none | avoid separate preventive-maintenance app |
| Assets | register, assignment-ready records, incidents | licenses, lifecycle, depreciation, QR audit/history | none | inventory assets vs customer AMC assets need shared model decision |
| Documents | client/customer/supplier documents and secure portal delivery | folders, versions, approvals, tags, expiry/signature | document governance within existing repository | a second file manager is rejected |
| Communication | email, templates, bulk campaigns, consent, delivery, inbound history, mentions | internal discussion/chat and announcements | team conversation layer | chat vs ticket conversation requires boundary review |
| Marketing | campaigns, segments, consent, events | lists, forms, landing capture, UTM, drip/newsletter, planner | campaign acquisition tools inside Communication | separate email marketing app is rejected |
| Automation | rules, execution and scheduled jobs | more triggers/actions, recurring workflows and approval actions | none | no second workflow engine |
| Analytics | custom/preset/scheduled reports and dashboards | more datasets, charts, saved views, exports | none | Report Builder vs Command Centre remain distinct |
| Administration | users, roles, permissions, branches, org, audit, security, APIs, backups | teams, departments, notification/email settings, multi-company depth | none | company vs organization terminology review |
| Customer portal | dashboard, quotes, invoices, payments, tickets, projects, documents, activity | AMC, service/asset history, chat and notification polish | none | standalone legacy portal must not diverge from integrated portal |
| Employee portal | payslips, attendance/leave/task primitives | employee dashboard, expenses, documents, goals, announcements | unified employee self-service route | avoid copying HR screens into another backend |
| Developer/API | keys, webhooks, logs and integration status | OAuth, versioned docs, rate-limit dashboard, marketplace health | OAuth client registry | API Hub and Live Integrations stay separate but linked |
| Security | RBAC, permissions, sessions, device/security events, audit, backup | password policies, data/file access log depth | none | Super Admin 2FA remains optional by owner decision |
| AI | single permission-aware assistant and approvals | email/reply/ticket/document/report skills through same architecture | none | multiple assistants rejected |
| Calendar/productivity | meetings/tasks/reminders/operations inbox | unified calendar, recurrence, notes, sharing | shared calendar projection | do not create separate task stores |
| Business operations | branches, approvals, tasks, inbox, alerts | departments, SOPs, policies, checklists, requests/resources | controlled SOP register | operational dashboard vs main dashboard review |

## Release plan

### Release 1 — Workforce lifecycle foundation (implemented)

The existing `Employees` app is extended with:

- department and designation masters;
- holiday calendar;
- job openings and candidate pipeline;
- candidate stage/rating updates;
- performance reviews with goals and development plan;
- training course catalogue and employee assignments;
- tenant scoping, validation, RBAC, audit events and training notifications;
- responsive reuse of existing tables, forms, KPI and empty-state components;
- dedicated regression coverage.

### Release 2 — Project delivery depth (implemented)

The existing `Projects & Work Orders` app is extended with:

- reusable project templates that generate milestones and tasks;
- tasks, subtasks, priorities, due dates and workspace assignees;
- dependency enforcement that blocks premature task execution;
- project expense capture included in profitability and budget variance;
- team workload derived from live assignments and timesheets;
- Gantt/calendar projection from milestones, tasks and dependencies;
- assignment notifications, tenant scoping, RBAC and audit events;
- expanded P0 regression coverage.

### Release 3 — Service/AMC completion

Extend existing AMC/Tickets/Dispatch: preventive schedules, service checklists, AMC assets, warranty/equipment history, renewal automation, CSAT and service report billing linkage.

### Release 4 — Document governance and employee self-service

Extend existing document repositories with folders, versions, tags, expiry, approval and access events. Expose permission-filtered attendance, leave, payslip, training, goals and documents through one employee self-service screen.

### Release 5 — Marketing acquisition and unified calendar

Extend Communication and Automation with forms, lead capture, UTM, drip journeys, newsletter planning and a shared calendar projection over meetings, tasks, visits, project milestones and reminders.

### Release 6 — Finance budgets and developer platform depth

Add budget control/variance, recurring expenses, improved statutory export packs, OAuth client registry, versioned API documentation, rate-limit visibility and webhook retry operations.

## Duplicate-prevention decisions

- No new CRM, HR, Help Desk, AMC, reporting, automation, AI, portal, API or security module is created when an existing canonical module already owns the workflow.
- Shared tasks, notifications, approvals, files, email, audit and authentication remain shared infrastructure.
- Proposed duplicate apps are rejected; missing capability is added to the canonical app.
- Ambiguous ownership is documented for manual review before implementation.
