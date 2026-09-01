'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const target = path.join(__dirname, '..', '.env');
if (!fs.existsSync(target)) {
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(target, [
    'PORT=4173',
    'NODE_ENV=development',
    `JWT_SECRET=${secret}`,
    'SESSION_DAYS=7',
    'COOKIE_SECURE=false',
    'AUTO_SEED=true',
    'AUTO_BACKUP=true',
    'AUTO_AUTOMATION=true',
    'ALLOW_DEV_RESET_TOKEN=false',
    'EMAIL_OTP_TTL_MINUTES=10',
    'DEFAULT_STATE_CODE=24',
    'APP_ENV=development',
    'TRUST_PROXY=false',
    'PROVIDER_TIMEOUT_MS=15000',
    'BREVO_API_KEY=',
    'BREVO_SENDER_EMAIL=techdefenderss@gmail.com',
    'BREVO_SENDER_NAME=Tech Defenders',
    'OLLAMA_ENABLED=false',
    'OLLAMA_URL=http://127.0.0.1:11434',
    'OLLAMA_MODEL=qwen3:4b',
    ''
  ].join('\n'), { mode: 0o600 });
  console.log('[setup] Created .env with a unique JWT secret.');
} else {
  console.log('[setup] Existing .env preserved.');
}
