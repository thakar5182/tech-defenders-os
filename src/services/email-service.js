'use strict';

/**
 * The single server-side email boundary. UI/routes must use this module,
 * never provider credentials or provider-specific APIs directly.
 */
const providers = require('./integrations');

function configuration() {
  const state = providers.providerState || null;
  const missing = providers.missingEmailCredentials();
  return {
    provider: providers.emailProvider(),
    from: providers.fromAddress(),
    fromName: String(process.env.EMAIL_FROM_NAME || process.env.BREVO_SENDER_NAME || 'Tech Defenders').trim(),
    configured: !missing.length,
    missing
  };
}

class EmailService {
  static validateConfiguration(orgId) {
    const status = configuration();
    if (!status.configured) {
      const error = new Error(`Email is not configured. Missing server configuration: ${status.missing.join(', ')}`);
      error.code = 'EMAIL_NOT_CONFIGURED';
      throw error;
    }
    if (orgId) providers.requireConfigured(orgId, 'email');
    return status;
  }

  static async sendEmail(input) {
    this.validateConfiguration(input.orgId);
    return providers.sendEmail(input);
  }

  static async sendBulkEmail(jobs) {
    return Promise.all((jobs || []).map(job => this.sendEmail(job)));
  }

  static async sendTemplateEmail(input) { return this.sendEmail(input); }
  static async sendAutomationEmail(input) { return this.sendEmail(input); }
  static async sendTestEmail(input) { return this.sendEmail({ ...input, subject: input.subject || 'Tech Defenders OS email test' }); }

  static getDeliveryStatus(job) {
    return job ? { status: job.status, providerId: job.providerId || null, sentAt: job.sentAt || null, error: job.error || null } : null;
  }
}

module.exports = EmailService;
