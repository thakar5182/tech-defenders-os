# CRM & ERP System Implementation Plan

This document outlines the step-by-step implementation plan for the new CRM, Sales, and Accounts workflows based on the provided requirements.

## 🌟 Phase 1: Core Architecture & Integration (Foundation)
Before modifying individual modules, we need to establish the foundational systems that allow seamless cross-module integration.

1.  **Centralized Contacts / Customer Schema**
    *   Create or update a central `Contacts` table as the single source of truth.
    *   Ensure any creation of a contact/customer in *any* module writes to this central schema.
    *   Fields to add/ensure: Company Name, Billing/Shipping Address, City, State, Country, PIN/ZIP, Contact Person, Designation, Mobile/Phone, Website, Email, GST details.
2.  **Global Attachment System**
    *   Create a unified attachment polymorphic relationship or central file management table.
    *   Implement upload, view, and delete logic that can be consumed by Leads, Contacts, Notes, Quotations, Sales Orders, Accounts, etc.
3.  **Cross-Module Relationship Mapping**
    *   Define foreign key constraints and relationships (e.g., `Lead` -> `Contact`, `Sales Order` -> `Receipt`).

## 💼 Phase 2: CRM Module Enhancements
Focus on updating the CRM sections (Leads, Contacts, Notes, Visits).

1.  **Leads Form Updates**
    *   **Add:** Material Code, GST options/details, Reference Details (with Date field).
    *   **Remove:** Product Interest.
    *   **Description UI:** Truncate to 1 line on the list/view screen; show full text on open/edit.
    *   **Action:** Add a "Generate Quotation" button (passes Lead details to Quotation module).
2.  **Contacts Management**
    *   Implement the UI for the comprehensive Contact fields defined in Phase 1.
    *   Add "Attach File" option to Contacts.
3.  **Notes**
    *   Enable attachments for notes.
    *   Display attached files clearly alongside the note text.
    *   Ensure CRUD (Create, Read, Update, Delete) is fully functional for notes.
4.  **Product Sales & Visits**
    *   Integrate Product Sales and Sales Visits within the CRM module.
    *   Show visit history and related sales activities directly inside the Customer/Lead profile.

## 🛒 Phase 3: Sales Workflow Implementation
Connecting the CRM to actual sales generation.

1.  **Quotations**
    *   Implement auto-generation logic from the CRM Lead's "Generate Quotation" button.
    *   Include fields: Customer details, Products/services, Quantity, Pricing, Taxes/GST, Description, Terms & conditions.
    *   Enable Actions: View, Edit, Print, Attachments, Save/Update.
2.  **Sales Orders**
    *   Add new fields: PO Number, Transport Details, Packing Details, Quantity.
    *   Link to Customer Number clearly.
3.  **Bill of Materials (BOM)**
    *   Associate BOMs directly with Sales Orders for easy access.

## 💰 Phase 4: Financials & Accounts Integration
Handling the post-sales pipeline.

1.  **Receipts**
    *   Add relationship field to link directly to a `Sales Order Number`.
    *   UI should display the associated Sales Order when viewing a Receipt.
2.  **Accounts Module**
    *   Centralize sales-related documents per customer/account.
    *   Maintain customer-wise ledgers: Payments, Payment History, Recurring Payments/Transactions, Outstanding Information.

## 🔄 Phase 5: Workflow Validation & Testing
Ensure the complete lifecycle works seamlessly without duplicate data entry.

**Test Scenario:**
1. Create **Lead** -> 2. Convert/Sync to **Contact** -> 3. Click **Generate Quotation** -> 4. Edit/Print **Quotation** -> 5. Convert to **Sales Order** (with PO/Transport) -> 6. Generate **BOM** -> 7. Process **Receipt** (Linked to SO) -> 8. Log **Payment** -> 9. View all history in **Accounts**.

---
*Please review this plan. Once approved, we can start executing these phases step-by-step!*
