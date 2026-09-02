'use strict';
const { OAuth2Client } = require('google-auth-library');

let client = null;

function configuredClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || '').trim();
}

function validatePayload(payload) {
  if (!payload || !payload.sub || !payload.email) throw new Error('Google identity is missing required account information');
  if (payload.email_verified !== true) throw new Error('Google account email is not verified');
  const issuer = String(payload.iss || '');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(issuer)) throw new Error('Google identity issuer is invalid');
  return {
    sub: String(payload.sub),
    email: String(payload.email).trim().toLowerCase(),
    name: String(payload.name || payload.given_name || payload.email.split('@')[0]).trim().slice(0, 120),
    picture: typeof payload.picture === 'string' && payload.picture.startsWith('https://') ? payload.picture : ''
  };
}

async function verifyCredential(credential) {
  const clientId = configuredClientId();
  if (!clientId) {
    const error = new Error('Google Sign-In is not configured');
    error.code = 'GOOGLE_AUTH_NOT_CONFIGURED';
    throw error;
  }
  if (!credential || String(credential).length > 10000) throw new Error('Google credential is required');
  if (!client) client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({ idToken: String(credential), audience: clientId });
  return validatePayload(ticket.getPayload());
}

module.exports = { configuredClientId, validatePayload, verifyCredential };
