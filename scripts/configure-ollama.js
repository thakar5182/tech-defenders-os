'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen3:4b';

function envFileValues() {
  const values = {};
  if (!fs.existsSync(ENV_FILE)) return values;
  for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function updateEnv(patch) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(patch).map(([key, value]) => [key, String(value)]));
  const updated = lines.map(line => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]); pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, updated.filter((line, index, all) => line || index < all.length - 1).join('\n') + '\n', { mode: 0o600 });
}

function findOllama() {
  const candidates = [
    'ollama',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe')
  ].filter(Boolean);
  for (const command of candidates) {
    if (command !== 'ollama' && !fs.existsSync(command)) continue;
    const result = spawnSync(command, ['--version'], { windowsHide: true, encoding: 'utf8' });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

async function tags() {
  try {
    const response = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const body = await response.json();
    return Array.isArray(body.models) ? body.models : [];
  } catch (_) { return null; }
}

async function waitForServer(seconds) {
  for (let attempt = 0; attempt < seconds * 2; attempt++) {
    const models = await tags();
    if (models) return models;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

function chooseModel(models, requested) {
  const names = models.map(model => String(model.name || model.model || '')).filter(Boolean);
  const preferences = [requested, DEFAULT_MODEL, 'llama3.2:3b'].filter(Boolean);
  for (const preferred of preferences) {
    const exact = names.find(name => name === preferred || name.replace(/:latest$/, '') === preferred.replace(/:latest$/, ''));
    if (exact) return exact;
  }
  return names[0] || null;
}

async function main() {
  console.log('[ollama] Detecting local Ollama installation...');
  const command = findOllama();
  if (!command) {
    updateEnv({ OLLAMA_ENABLED: 'false', OLLAMA_URL, OLLAMA_MODEL: DEFAULT_MODEL });
    console.log('[ollama] Ollama was not found. AI Quote Draft remains disabled.');
    console.log('[ollama] Install Ollama, then run: node scripts\\configure-ollama.js');
    return;
  }

  let models = await tags();
  if (!models) {
    console.log('[ollama] Starting the local Ollama service...');
    const child = spawn(command, ['serve'], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    models = await waitForServer(20);
  }
  if (!models) {
    updateEnv({ OLLAMA_ENABLED: 'false', OLLAMA_URL, OLLAMA_MODEL: DEFAULT_MODEL });
    console.log('[ollama] Ollama is installed but its local API did not start. AI remains disabled.');
    return;
  }

  const existing = envFileValues();
  let model = chooseModel(models, existing.OLLAMA_MODEL);
  if (!model) {
    console.log(`[ollama] No model found. Downloading ${DEFAULT_MODEL}; this can take time...`);
    const pull = spawnSync(command, ['pull', DEFAULT_MODEL], { stdio: 'inherit', windowsHide: false });
    if (pull.status === 0) {
      models = await tags() || [];
      model = chooseModel(models, DEFAULT_MODEL);
    }
  }
  if (!model) {
    updateEnv({ OLLAMA_ENABLED: 'false', OLLAMA_URL, OLLAMA_MODEL: DEFAULT_MODEL });
    console.log('[ollama] Model download was not completed. AI remains disabled; setup can still continue.');
    return;
  }

  updateEnv({ OLLAMA_ENABLED: 'true', OLLAMA_URL, OLLAMA_MODEL: model });
  console.log(`[ollama] Ready: ${model} at ${OLLAMA_URL}`);
  console.log('[ollama] Open Sales > AI Quote Draft inside Tech Defenders OS.');
}

main().catch(error => {
  console.log('[ollama] Configuration skipped: ' + error.message);
  process.exitCode = 0;
});
