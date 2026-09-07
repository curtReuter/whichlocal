/**
 * Post each new job call into its local's Discord forum thread.
 *
 * Layout: one **forum channel per state** (ids in scripts/job-calls.config.json
 * → discord.forums), one **thread per local** inside it. The thread is created
 * the first time a local has a call to post; its id is saved to
 * scripts/discord-threads.json so later runs post to the same thread (pre-seed a
 * row there to reuse a thread you made by hand). Members "Follow" the threads
 * for the locals they care about.
 *
 *   node scripts/notify-discord.mjs
 *   node scripts/notify-discord.mjs --dry-run     # print what it would do
 *   node scripts/notify-discord.mjs --all         # post EVERY current call (test)
 *
 * Needs the repo secret DISCORD_BOT_TOKEN (bot invited with: View Channels,
 * Send Messages, Send Messages in Threads, Create Public Threads, Embed Links,
 * Read Message History). Missing token → exits quietly. A local whose state has
 * no forum configured falls back to discord.default_channel_id, else is skipped.
 * Outbound only — no gateway, no slash commands, safe as a one-shot Action.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DELTA = join(ROOT, 'scripts', 'cache', 'job-calls-delta.json');
const FULL = join(ROOT, 'js', 'data', 'job-calls.json');
const CONFIG = join(ROOT, 'scripts', 'job-calls.config.json');
const THREADS = join(ROOT, 'scripts', 'discord-threads.json');
const API = 'https://discord.com/api/v10';

const DRY = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all') || process.env.NOTIFY_ALL === '1';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

const GREEN = 0x12905a;
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const place = (slug) => {
  const parts = slug.replace(/^l\d+-/, '').split('-');
  const state = (parts.pop() || '').toUpperCase();
  return { city: parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), state };
};
const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
};

/* ---------- what to post -------------------------------------------------- */

let added;
if (ALL) {
  const locals = readJson(FULL, { locals: {} }).locals || {};
  added = Object.fromEntries(Object.entries(locals).map(([slug, l]) =>
    [slug, { local_no: l.local_no, url: l.url, posted: l.posted, ...place(slug), calls: l.calls || [] }]));
} else {
  if (!existsSync(DELTA)) {
    console.log('No job-calls-delta.json — run scrape-job-calls.mjs first. Nothing to send.');
    process.exit(0);
  }
  added = readJson(DELTA, { added: {} }).added || {};
}

const slugs = Object.keys(added).filter((s) => (added[s].calls || []).length);
if (!slugs.length) {
  console.log(ALL ? 'No job calls at all.' : 'No new job calls.');
  process.exit(0);
}
if (!DRY && !BOT_TOKEN) {
  console.warn('DISCORD_BOT_TOKEN not set — skipping notifications.');
  process.exit(0);
}

const discordCfg = readJson(CONFIG, {}).discord || {};
const forums = discordCfg.forums || {};
const defaultChannel = discordCfg.default_channel_id || '';
const threads = readJson(THREADS, {});
let threadsDirty = false;

/* ---------- Discord REST ----------------------------------------------- */

async function discord(method, path, body) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${BOT_TOKEN}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = ((await res.json().catch(() => ({}))).retry_after ?? 1) * 1000 + 300;
      console.warn(`rate limited — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await res.text();
    if (!res.ok) { const e = new Error(`Discord ${res.status}: ${text}`); e.status = res.status; throw e; }
    return text ? JSON.parse(text) : {};
  }
  throw new Error('gave up after repeated 429s');
}

function embedsFor(slug) {
  const l = added[slug];
  const city = l.city || place(slug).city;
  const state = l.state || place(slug).state;
  return l.calls.map((c) => ({
    color: GREEN,
    author: { name: `IBEW Local ${l.local_no} — ${city}, ${state}` },
    title: trunc(`${c.count}× ${c.classification} — ${ALL ? 'job call' : 'new job call'}`, 256),
    description: trunc(c.text, 3900) + (c.open_until_filled ? '\n\n**OPEN UNTIL FILLED**' : ''),
    url: l.url,
    footer: { text: l.posted ? `List posted ${l.posted} · whichlocal` : 'whichlocal' },
    timestamp: new Date().toISOString(),
  }));
}

const chunk10 = (arr) => {
  const out = [];
  for (let i = 0; i < arr.length; i += 10) out.push(arr.slice(i, i + 10));
  return out;
};

/* ---------- run ------------------------------------------------------- */

let posted = 0;
let skipped = 0;

for (const slug of slugs) {
  const l = added[slug];
  const state = l.state || place(slug).state;
  const forumId = forums[state] || defaultChannel;
  const batches = chunk10(embedsFor(slug));
  let threadId = threads[slug];

  if (!threadId && !forumId) {
    console.warn(`  ${slug}: no forum for ${state} and no default_channel_id — skipped`);
    skipped += 1;
    continue;
  }

  if (DRY) {
    console.log(`  ${slug}: ${threadId ? `post ${batches.flat().length} embed(s) to thread ${threadId}`
      : `create thread "IBEW Local ${l.local_no} — ${l.city || place(slug).city}" in forum ${forumId}, then post ${batches.flat().length} embed(s)`}`);
    posted += batches.flat().length;
    continue;
  }

  try {
    let start = 0;
    if (!threadId) {
      const thread = await discord('POST', `/channels/${forumId}/threads`, {
        name: trunc(`IBEW Local ${l.local_no} — ${l.city || place(slug).city}`, 100),
        message: { embeds: batches[0] },
      });
      threadId = thread.id;
      threads[slug] = threadId;
      threadsDirty = true;
      start = 1;
      console.log(`  ${slug}: created thread ${threadId}`);
    }
    for (let i = start; i < batches.length; i += 1) {
      try {
        await discord('POST', `/channels/${threadId}/messages`, { embeds: batches[i] });
      } catch (e) {
        if (e.status === 404 && start === 0) {
          // stored thread is gone — drop it and recreate on the next run
          delete threads[slug];
          threadsDirty = true;
          console.warn(`  ${slug}: thread ${threadId} missing (404) — cleared, will recreate next run`);
          break;
        }
        throw e;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    posted += batches.flat().length;
  } catch (e) {
    console.error(`  ${slug}: ${e.message}`);
    skipped += 1;
  }
}

if (threadsDirty && !DRY) {
  writeFileSync(THREADS, JSON.stringify(threads, null, 2) + '\n');
}

console.log(
  `${DRY ? 'Would post' : 'Posted'} ${posted} embed(s) across ${slugs.length - skipped} local(s)` +
  `${skipped ? `, ${skipped} skipped` : ''}.`,
);
