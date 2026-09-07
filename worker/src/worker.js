/**
 * Which Local — submission worker.
 *
 * Receives the site's "Edit Data" / "Add Job Call" / "Flag filled" forms,
 * verifies the hCaptcha token, stores any wage-sheet upload in R2, and opens a
 * GitHub issue in the repo. Replaces the Web3Forms → email path.
 *
 * Bindings (wrangler.toml):
 *   R2  UPLOADS            — bucket for wage-sheet files
 *   var GITHUB_OWNER       — e.g. "curtReuter"
 *   var GITHUB_REPO        — e.g. "whichlocal"
 *   var ALLOWED_ORIGIN     — the site origin, or "*" to accept any
 *   secret GITHUB_TOKEN    — fine-grained PAT, Issues: read+write on the repo
 *   secret HCAPTCHA_SECRET — from hcaptcha.com (must match the site's sitekey)
 *
 * Routes:
 *   POST /            — submit a form  → { success: boolean, message? }
 *   GET  /f/<key>     — stream a stored upload (issue bodies link here)
 */

const MAX_UPLOAD = 9 * 1024 * 1024; // 9 MB

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/f/')) {
      return serveFile(url.pathname.slice(3), env, cors);
    }
    if (request.method !== 'POST' || url.pathname !== '/') {
      return json({ success: false, message: 'Not found' }, 404, cors);
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ success: false, message: 'Bad form data' }, 400, cors);
    }

    // honeypot — quietly accept and drop
    if (form.get('botcheck')) return json({ success: true }, 200, cors);

    const token = String(form.get('h-captcha-response') || '');
    if (!token || !(await verifyCaptcha(token, env, request))) {
      return json({ success: false, message: 'Captcha check failed — please retry.' }, 400, cors);
    }

    let fileLink = '';
    const file = form.get('wage_sheet');
    if (file && typeof file === 'object' && typeof file.arrayBuffer === 'function' && file.size > 0) {
      if (file.size > MAX_UPLOAD) {
        return json({ success: false, message: 'File is over 9 MB.' }, 400, cors);
      }
      const safe = String(file.name || 'upload').replace(/[^\w.\-]+/g, '_').slice(-80) || 'upload';
      const key = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID().slice(0, 8)}-${safe}`;
      await env.UPLOADS.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || 'application/octet-stream' },
      });
      fileLink = `${url.origin}/f/${key}`;
    }

    const issue = buildIssue(form, fileLink);
    const gh = await createIssue(issue, env);
    if (!gh.ok) {
      console.error('github issue create failed', gh.status, gh.text);
      return json({ success: false, message: 'Could not file the submission — try again later.' }, 502, cors);
    }
    return json({ success: true }, 200, cors);
  },
};

/* ---------- helpers -------------------------------------------------------- */

function corsHeaders(request, env) {
  const allow = env.ALLOWED_ORIGIN || '*';
  const origin = request.headers.get('Origin') || '';
  const value = allow === '*'
    ? '*'
    : (origin === allow || /^http:\/\/localhost(:\d+)?$/.test(origin)) ? origin : allow;
  return {
    'Access-Control-Allow-Origin': value,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function verifyCaptcha(token, env, request) {
  if (!env.HCAPTCHA_SECRET) return false;
  const body = new URLSearchParams({ secret: env.HCAPTCHA_SECRET, response: token });
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.set('remoteip', ip);
  try {
    const r = await fetch('https://api.hcaptcha.com/siteverify', { method: 'POST', body });
    const out = await r.json();
    if (out.success !== true) console.error('hcaptcha verify failed', JSON.stringify(out));
    return out.success === true;
  } catch (e) {
    console.error('hcaptcha verify error', e.message);
    return false;
  }
}

async function serveFile(rawKey, env, cors) {
  const key = decodeURIComponent(rawKey);
  const obj = await env.UPLOADS.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: cors });
  const h = new Headers(cors);
  obj.writeHttpMetadata(h);
  h.set('Cache-Control', 'private, max-age=3600');
  h.set('Content-Disposition', `inline; filename="${key.split('/').pop()}"`);
  return new Response(obj.body, { headers: h });
}

const stripIbew = (s) => s.replace(/^IBEW\s+/, '');

function buildIssue(form, fileLink) {
  const kind = String(form.get('kind') || '');
  const localLine = String(form.get('local') || 'Unknown local');
  const slug = String(form.get('local_slug') || '');
  const no = String(form.get('local_no') || '').replace(/\D/g, '');
  const page = String(form.get('page') || '');
  const notes = String(form.get('notes') || '').trim();
  const today = new Date().toISOString().slice(0, 10);

  const meta =
    `**Local:** ${localLine}${slug ? ` (\`${slug}\`)` : ''}\n` +
    (page ? `**From:** ${page}\n` : '') +
    `**Submitted:** ${today}\n`;

  if (kind === 'edit') {
    const changes = String(form.get('proposed_changes') || '').trim();
    let snippet = '';
    try {
      const obj = JSON.parse(String(form.get('changes_json') || '{}'));
      if (no && obj && Object.keys(obj).length) {
        const entry = { ...obj, note: `visitor submission ${today}` };
        snippet = '\n\n**Paste into `scripts/overrides.json`:**\n\n```json\n' +
          `"${no}": ${JSON.stringify(entry)}\n` + '```\n';
      }
    } catch { /* leave snippet empty */ }
    return {
      title: `Wage edit — ${stripIbew(localLine)}`,
      labels: ['wage-correction'],
      body:
        meta +
        `\n### Proposed changes\n\n${changes || '_(no figure edits — see notes / wage sheet)_'}\n` +
        (notes ? `\n### Notes\n\n${notes}\n` : '') +
        (fileLink ? `\n### Wage sheet\n\n${fileLink}\n` : '') +
        snippet,
    };
  }

  if (kind === 'delcall') {
    const list = String(form.get('remove_calls') || '').trim();
    return {
      title: `Remove job call(s) — ${stripIbew(localLine)}`,
      labels: ['job-call-removal'],
      body:
        meta +
        `\n### Calls reported filled / no longer posted\n\n${list || '_(none listed)_'}\n` +
        (notes ? `\n### Notes\n\n${notes}\n` : '') +
        '\n_Remove the matching line(s) from `scripts/job-calls.overrides.json`, ' +
        'or wait for the next scrape if it was a scraped call._\n',
    };
  }

  // add a job call
  const call = String(form.get('job_call') || '').trim();
  const source = String(form.get('source') || '').trim();
  const snippet = no
    ? '\n\n**Paste into `scripts/job-calls.overrides.json`:**\n\n```json\n' +
      `"${no}": { "calls": [ { "text": ${JSON.stringify(call)} } ] }\n` + '```\n'
    : '';
  return {
    title: `Job call — ${stripIbew(localLine)}`,
    labels: ['job-call'],
    body:
      meta +
      `\n### Job call\n\n${call}\n` +
      (source ? `\n**Source:** ${source}\n` : '') +
      (notes ? `\n### Notes\n\n${notes}\n` : '') +
      snippet,
  };
}

async function createIssue({ title, body, labels }, env) {
  const endpoint = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`;
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'whichlocal-submit-worker',
    'Content-Type': 'application/json',
  };
  const post = (payload) => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });

  let r = await post({ title, body, labels });
  if (r.status === 422 && labels && labels.length) {
    // a label doesn't exist yet — retry without labels so the issue still lands
    r = await post({ title, body });
  }
  return { ok: r.ok, status: r.status, text: r.ok ? '' : await r.text().catch(() => '') };
}
