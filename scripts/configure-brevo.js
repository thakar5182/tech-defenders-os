'use strict';
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');
const SENDER_EMAIL = 'techdefenderss@gmail.com';
const SENDER_NAME = 'Tech Defenders';

function updateEnv(patch) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(patch).map(([key, value]) => [key, String(value)]));
  const updated = lines.map(line => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, updated.filter((line, index, all) => line || index < all.length - 1).join('\n') + '\n', { mode: 0o600 });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const apiKey = raw.trim();
  if (!/^[\x21-\x7e]{20,512}$/.test(apiKey)) {
    console.error('[brevo] Invalid API key. Use the complete key copied from Brevo (no spaces).');
    process.exitCode = 1;
    return;
  }
  updateEnv({
    BREVO_API_KEY: apiKey,
    BREVO_SENDER_EMAIL: SENDER_EMAIL,
    BREVO_SENDER_NAME: SENDER_NAME
  });
  raw = '';
  console.log(`[brevo] Email OTP configured for verified sender ${SENDER_EMAIL}.`);
  console.log('[brevo] The API key was written only to local .env and was not displayed.');
});

