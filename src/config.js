import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepMerge, readJson, writeJson } from './util.js';

export const homeDir = () => path.resolve(process.env.DICODE_HOME || path.join(os.homedir(), '.dicode'));
export const userSettingsPath = () => path.join(homeDir(), 'settings.json');
export const projectSettingsPath = (root) => path.join(root, '.dicode', 'settings.json');
export const localSettingsPath = (root) => path.join(root, '.dicode', 'settings.local.json');

export const DEFAULTS = {
  model: 'anthropic/claude-sonnet-5-5',
  fallbackModels: [],
  maxOutputTokens: 16000,
  thinking: { enabled: false, budgetTokens: 8000 },
  maxSteps: 200,
  autoCompactTokens: 160000,
  contextWindow: 200000,
  permissions: { defaultMode: 'default', allow: [], ask: [], deny: [] },
  hooks: {},
  bash: { defaultTimeoutSec: 120, maxTimeoutSec: 600, maxOutputChars: 30000 },
  web: { allowPrivate: false, braveApiKey: '' },
  providers: {
    anthropic: { apiKey: '', baseUrl: '' },
    openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1' },
    openrouter: { apiKey: '', baseUrl: 'https://openrouter.ai/api/v1' },
    ollama: { apiKey: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  },
  pricing: {},
};

/** Permission rule lists are additive across layers; everything else is a deep merge. */
function merge(a, b) {
  const out = deepMerge(a, b);
  if (b?.permissions) {
    for (const k of ['allow', 'ask', 'deny']) out.permissions[k] = [...new Set([...(a.permissions?.[k] || []), ...(b.permissions[k] || [])])];
  }
  return out;
}

/** Is this folder trusted to supply hooks and allow-rules? */
const trustFile = () => path.join(homeDir(), 'trusted.json');
export const isTrusted = (root) => readJson(trustFile(), []).includes(root);
export function trust(root) {
  const list = readJson(trustFile(), []);
  if (!list.includes(root)) writeJson(trustFile(), [...list, root]);
}

/**
 * Layers: defaults < user (~/.dicode/settings.json) < project (.dicode/settings.json) < local (.dicode/settings.local.json) < CLI.
 * Untrusted projects cannot add hooks or allow-rules (a cloned repo must not be able to run commands on its own).
 */
export function loadSettings(root, cli = {}) {
  let s = merge(structuredClone(DEFAULTS), readJson(userSettingsPath(), {}));
  const trusted = isTrusted(root) || cli.trustProject;
  for (const file of [projectSettingsPath(root), localSettingsPath(root)]) {
    let layer = readJson(file, null);
    if (!layer) continue;
    if (!trusted) {
      layer = { ...layer };
      delete layer.hooks;
      if (layer.permissions) layer.permissions = { deny: layer.permissions.deny || [] };
    }
    s = merge(s, layer);
  }
  s = merge(s, cli.settings || {});
  if (process.env.ANTHROPIC_BASE_URL && !s.providers.anthropic.baseUrl) s.providers.anthropic.baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (process.env.DICODE_MODEL && !cli.settings?.model) s.model = process.env.DICODE_MODEL;
  s._trusted = !!trusted;
  return s;
}

export function resolveProvider(settings, name) {
  const p = settings.providers[name] || {};
  const envName = `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  const apiKey = p.apiKey || process.env[envName] || '';
  if (name === 'anthropic') return { name, kind: 'anthropic', apiKey, baseUrl: (p.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') };
  if (!p.baseUrl) throw new Error(`Unknown provider "${name}". Add providers.${name}.baseUrl to your settings.`);
  return { name, kind: 'openai', apiKey, baseUrl: p.baseUrl.replace(/\/$/, '') };
}

export function updateSettingsFile(file, fn) {
  const cur = readJson(file, {});
  const next = fn(cur) || cur;
  writeJson(file, next, 0o600);
  return next;
}

/** Make sure personal settings never get committed. */
export function ensureLocalIgnored(root) {
  const dir = path.join(root, '.dicode');
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'settings.local.json\n');
}
