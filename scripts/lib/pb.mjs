/**
 * Tiny helpers shared by the setup + scrape scripts: read the root .env, log in
 * as the PocketBase superuser, and make authenticated API calls.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Parse the root .env into process.env (does not override existing vars). */
export function loadEnv() {
  let text = '';
  try {
    text = readFileSync(join(ROOT, '.env'), 'utf8');
  } catch {
    return; // no .env — rely on the real environment
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function pbConfig() {
  loadEnv();
  const url = (process.env.PB_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
  const email = process.env.PB_ADMIN_EMAIL;
  const password = process.env.PB_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD missing from .env');
  }
  return { url, email, password };
}

/** Authenticate as superuser; returns { url, token }. */
export async function pbAuth() {
  const { url, email, password } = pbConfig();
  const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: email, password }),
  }).catch((e) => {
    throw new Error(`Cannot reach PocketBase at ${url} — is \`pb/pocketbase serve\` running? (${e.message})`);
  });
  if (!res.ok) {
    throw new Error(`PocketBase superuser auth failed (${res.status}): ${await res.text()}`);
  }
  const { token } = await res.json();
  return { url, token };
}

/** Authenticated fetch against the PB API. Returns parsed JSON (or null on 204). */
export async function pbFetch(ctx, path, init = {}) {
  const res = await fetch(`${ctx.url}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: ctx.token,
      ...(init.headers || {}),
    },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${JSON.stringify(body)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export { ROOT };
