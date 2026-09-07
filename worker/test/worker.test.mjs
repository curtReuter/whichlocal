import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

/** minimal env with an in-memory R2 stub */
function mockEnv(over = {}) {
  const store = new Map();
  return {
    GITHUB_OWNER: 'o',
    GITHUB_REPO: 'r',
    GITHUB_TOKEN: 't',
    HCAPTCHA_SECRET: 's',
    ALLOWED_ORIGIN: '*',
    UPLOADS: {
      put: async (k, v) => { store.set(k, v); },
      get: async (k) => (store.has(k)
        ? { body: 'data', writeHttpMetadata() {} }
        : null),
    },
    _store: store,
    ...over,
  };
}

/** capture outbound fetches; drive hCaptcha + GitHub responses */
function stubFetch({ captcha = true, ghStatus = 201 } = {}) {
  const calls = [];
  globalThis.fetch = async (u, init) => {
    const url = String(u);
    calls.push({ url, init });
    if (url.includes('hcaptcha.com/siteverify')) {
      return new Response(JSON.stringify({ success: captcha }), { status: 200 });
    }
    if (url.includes('api.github.com')) {
      return new Response(ghStatus < 400 ? '{"number":1}' : '{"message":"nope"}', { status: ghStatus });
    }
    return new Response('{}', { status: 200 });
  };
  return calls;
}

const post = (fd) => new Request('https://w.dev/', { method: 'POST', body: fd });

test('edit submission opens a wage-correction issue with a paste snippet', async () => {
  const calls = stubFetch();
  const fd = new FormData();
  fd.set('kind', 'edit');
  fd.set('h-captcha-response', 'tok');
  fd.set('local', 'IBEW Local 606 — Orlando, FL');
  fd.set('local_slug', 'l606-orlando-fl');
  fd.set('local_no', '606');
  fd.set('proposed_changes', 'Hourly rate: 31.29 → 32.64');
  fd.set('changes_json', JSON.stringify({ hourly_rate: 32.64 }));

  const res = await worker.fetch(post(fd), mockEnv());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });

  const gh = calls.find((c) => c.url.includes('api.github.com'));
  const payload = JSON.parse(gh.init.body);
  assert.match(payload.title, /^Wage edit — Local 606/);
  assert.deepEqual(payload.labels, ['wage-correction']);
  assert.match(payload.body, /"606": \{"hourly_rate":32\.64,"note":"visitor submission/);
});

test('add-job-call submission', async () => {
  const calls = stubFetch();
  const fd = new FormData();
  fd.set('kind', 'jobcall');
  fd.set('h-captcha-response', 'tok');
  fd.set('local', 'IBEW Local 915 — Tampa, FL');
  fd.set('local_no', '915');
  fd.set('job_call', '2 JW calls for Test Co, $34/hr.');
  fd.set('source', 'https://example.org');

  const res = await worker.fetch(post(fd), mockEnv());
  assert.equal((await res.json()).success, true);
  const payload = JSON.parse(calls.find((c) => c.url.includes('github')).init.body);
  assert.match(payload.title, /^Job call — Local 915/);
  assert.deepEqual(payload.labels, ['job-call']);
  assert.match(payload.body, /"915": \{ "calls": \[ \{ "text": "2 JW calls for Test Co, \$34\/hr\." \} \] \}/);
});

test('flag-filled submission lists the calls', async () => {
  const calls = stubFetch();
  const fd = new FormData();
  fd.set('kind', 'delcall');
  fd.set('h-captcha-response', 'tok');
  fd.set('local', 'IBEW Local 606 — Orlando, FL');
  fd.set('local_no', '606');
  fd.set('remove_calls', '1. one\n\n2. two');

  await worker.fetch(post(fd), mockEnv());
  const payload = JSON.parse(calls.find((c) => c.url.includes('github')).init.body);
  assert.match(payload.title, /^Remove job call\(s\) — Local 606/);
  assert.deepEqual(payload.labels, ['job-call-removal']);
  assert.match(payload.body, /1\. one/);
});

test('wage-sheet file is stored and linked', async () => {
  const calls = stubFetch();
  const env = mockEnv();
  const fd = new FormData();
  fd.set('kind', 'edit');
  fd.set('h-captcha-response', 'tok');
  fd.set('local', 'IBEW Local 606 — Orlando, FL');
  fd.set('local_no', '606');
  fd.set('changes_json', '{}');
  fd.set('wage_sheet', new File([new Uint8Array(10)], 'sheet.pdf', { type: 'application/pdf' }));

  await worker.fetch(post(fd), env);
  assert.equal(env._store.size, 1);
  const key = [...env._store.keys()][0];
  const payload = JSON.parse(calls.find((c) => c.url.includes('github')).init.body);
  assert.match(payload.body, new RegExp(`/f/${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('bad captcha is rejected, no issue', async () => {
  const calls = stubFetch({ captcha: false });
  const fd = new FormData();
  fd.set('kind', 'jobcall');
  fd.set('h-captcha-response', 'tok');
  fd.set('local', 'IBEW Local 1 — St. Louis, MO');
  fd.set('job_call', 'x');

  const res = await worker.fetch(post(fd), mockEnv());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).success, false);
  assert.equal(calls.some((c) => c.url.includes('github')), false);
});

test('honeypot silently accepts and files nothing', async () => {
  const calls = stubFetch();
  const fd = new FormData();
  fd.set('botcheck', 'on');
  fd.set('kind', 'jobcall');
  fd.set('h-captcha-response', 'tok');

  const res = await worker.fetch(post(fd), mockEnv());
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(calls.some((c) => c.url.includes('github')), false);
});

test('GET /f/<key> streams a stored upload', async () => {
  const env = mockEnv();
  await env.UPLOADS.put('2026-09-10/abcd1234-sheet.pdf', 'x');
  const res = await worker.fetch(
    new Request('https://w.dev/f/2026-09-10/abcd1234-sheet.pdf'),
    env,
  );
  assert.equal(res.status, 200);
});

test('OPTIONS preflight', async () => {
  const res = await worker.fetch(
    new Request('https://w.dev/', { method: 'OPTIONS', headers: { Origin: 'https://x' } }),
    mockEnv(),
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('GitHub failure surfaces as success:false', async () => {
  stubFetch({ ghStatus: 500 });
  const fd = new FormData();
  fd.set('kind', 'jobcall');
  fd.set('h-captcha-response', 'tok');
  fd.set('local', 'IBEW Local 1 — St. Louis, MO');
  fd.set('job_call', 'x');
  const res = await worker.fetch(post(fd), mockEnv());
  assert.equal(res.status, 502);
  assert.equal((await res.json()).success, false);
});
