/**
 * Keep each local's Discord **forum thread** current:
 *   • the thread's opening post is a live compensation card (rebuilt every run
 *     from js/data/locals.json — Total package, hourly, pensions, COL, dues …);
 *   • new job calls are posted below it as individual messages;
 *   • when a call drops off the local's list, its message is deleted.
 *
 * Layout: one forum channel per state (ids in scripts/job-calls.config.json →
 * discord.forums), one thread per local. Threads are created on first run and
 * their ids saved to scripts/discord-threads.json as { thread, comp, calls } —
 * `comp` is the message the bot edits (the forum starter message when the bot
 * made the thread, otherwise a pinned bot message); `calls` maps each posted
 * job call's id to its Discord message id, so the message can be removed when
 * scrape-job-calls.mjs reports the call as gone.
 *
 *   node scripts/notify-discord.mjs
 *   node scripts/notify-discord.mjs --dry-run     # print what it would do
 *   node scripts/notify-discord.mjs --all         # also (re)post every current call
 *
 * Needs the repo secret DISCORD_BOT_TOKEN (bot invited with: View Channels,
 * Send Messages, Send Messages in Threads, Create Public Threads, Manage
 * Messages, Embed Links, Read Message History). Missing token → exits quietly.
 * A local whose state has no forum falls back to discord.default_channel_id,
 * else is skipped. Outbound only — no gateway, no slash commands.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Compensation fields for the thread's opening card — keep labels/formats in
// sync with js/metrics.js (order = display order). Kept inline because that file
// is a browser ES module Node can't import here.
const perHr = (v) => `$${v.toFixed(2)}/hr`;
const COMP_METRICS = [
  ['total_package', 'Total package', perHr],
  ['hourly_rate', 'Hourly rate', perHr],
  ['yearly_salary', 'Yearly salary', (v) => `$${Math.round(v).toLocaleString('en-US')}`],
  ['col_pct', 'Cost of living', (v) => `${Math.round(v)}%`],
  ['defined_pension', 'Defined pension', perHr],
  ['contribution_pension', 'Contribution pension', perHr],
  ['k401', '401(k)', perHr],
  ['vacation', 'Vacation', perHr],
  ['hw', 'Health & welfare', perHr],
  ['nebf_pension', 'NEBF pension', perHr],
  ['dues', 'Union dues', (v) => `${v}%`],
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DELTA = join(ROOT, 'scripts', 'cache', 'job-calls-delta.json');
const FULL = join(ROOT, 'js', 'data', 'job-calls.json');
const LOCALS = join(ROOT, 'js', 'data', 'locals.json');
const CONFIG = join(ROOT, 'scripts', 'job-calls.config.json');
const THREADS = join(ROOT, 'scripts', 'discord-threads.json');
const API = 'https://discord.com/api/v10';

const DRY = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all') || process.env.NOTIFY_ALL === '1';
// --comp-only: just re-sync the comp card on threads that already exist — no job
// calls, no thread creation, no state file writes. Used by the wage-data
// workflows (scrape.yml / apply-overrides.yml) so the card updates the moment
// locals.json changes, not only on the 2-hourly job-calls run.
const COMP_ONLY = process.argv.includes('--comp-only') || process.env.COMP_ONLY === '1';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

const GREEN = 0x12905a;   // job-call embeds
const BLUE = 0x2c7bb6;    // compensation card (the app's --accent)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const readJson = (p, fallback) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
};
const place = (slug) => {
  const parts = slug.replace(/^l\d+-/, '').split('-');
  const state = (parts.pop() || '').toUpperCase();
  return { city: parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), state };
};
const localNoOf = (slug) => Number(slug.match(/^l(\d+)/)?.[1]) || null;

/* ---------- inputs ---------------------------------------------------- */

const cfg = readJson(CONFIG, {});
const forums = cfg.discord?.forums || {};
const defaultChannel = cfg.discord?.default_channel_id || '';

// locals.json carries a few non-canonical state strings ("Ont.", "IA / IL");
// discord.forums is keyed by the same normalised 2-letter codes the registry uses.
const normState = (s) => {
  s = String(s || '').trim();
  if (/^ont\.?$/i.test(s)) return 'ON';
  if (s.includes('/')) s = s.split('/')[0].trim();
  return s.toUpperCase();
};
const siteUrl = (cfg.site_url || 'https://curtreuter.github.io/whichlocal/').replace(/\/?$/, '/');

const localBySlug = new Map(
  (readJson(LOCALS, { items: [] }).items || []).map((i) => [i.slug, i]),
);

// job calls that are new since the last scrape (or every call, with --all)
let newCalls = {};
if (COMP_ONLY) {
  // leave newCalls empty
} else if (ALL) {
  const locals = readJson(FULL, { locals: {} }).locals || {};
  newCalls = Object.fromEntries(Object.entries(locals).map(([s, l]) => [s, l.calls || []]));
} else if (existsSync(DELTA)) {
  const added = readJson(DELTA, { added: {} }).added || {};
  newCalls = Object.fromEntries(Object.entries(added).map(([s, a]) => [s, a.calls || []]));
}

// job calls that dropped off a local's list since the last scrape → their
// Discord messages get deleted (slug → [callId, …]). Not in --comp-only or --all.
let filledCalls = {};
if (!COMP_ONLY && !ALL && existsSync(DELTA)) {
  const filled = readJson(DELTA, { filled: {} }).filled || {};
  filledCalls = Object.fromEntries(Object.entries(filled).map(([s, f]) => [s, f.ids || []]));
}

const threads = readJson(THREADS, {});
let threadsDirty = false;
const entryOf = (slug) => {
  const v = threads[slug];
  if (!v) return null;
  const e = typeof v === 'string' ? { thread: v, comp: v } : v; // migrate legacy string form
  if (!e.calls) e.calls = {}; // callId → Discord message id
  return e;
};

if (!DRY && !BOT_TOKEN) {
  console.warn('DISCORD_BOT_TOKEN not set — skipping.');
  process.exit(0);
}

const slugs = [...new Set([
  ...Object.keys(cfg).filter((k) => /^l\d/.test(k)),
  ...Object.keys(newCalls).filter((s) => newCalls[s].length),
  ...Object.keys(filledCalls).filter((s) => filledCalls[s].length),
])];
if (!slugs.length) {
  console.log('No locals configured for job calls.');
  process.exit(0);
}

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
      console.warn(`  rate limited — waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (!res.ok) { const e = new Error(`${method} ${path} → ${res.status}: ${text}`); e.status = res.status; throw e; }
    return text ? JSON.parse(text) : {};
  }
  throw new Error('gave up after repeated 429s');
}

/* ---------- embeds --------------------------------------------------- */

function compEmbed(slug) {
  const l = localBySlug.get(slug);
  const p = place(slug);
  const name = `IBEW Local ${localNoOf(slug) ?? ''}`.trim() +
    (l ? ` — ${l.city}, ${l.state}` : p.city ? ` — ${p.city}, ${p.state}` : '');

  const fields = [];
  if (l) {
    for (const [id, label, fmt] of COMP_METRICS) {
      const v = l[id];
      if (typeof v === 'number' && v !== 0) fields.push({ name: label, value: fmt(v), inline: true });
    }
  }

  const links = [`[view on the map](${siteUrl})`];
  if (l?.wage_sheet_url) links.push(`[wage sheet](${l.wage_sheet_url})`);

  return {
    color: BLUE,
    title: trunc(name, 256),
    description:
      'Journeyman compensation for this local. New job calls appear below as they’re listed.\n\n' +
      links.join(' · '),
    fields: fields.length ? fields : undefined,
    footer: { text: l?.source_updated ? `Wage data updated ${l.source_updated} · whichlocal` : 'whichlocal' },
    timestamp: new Date().toISOString(),
  };
}

function callEmbed(slug, c) {
  const l = localBySlug.get(slug);
  const p = place(slug);
  const jc = readJson(FULL, { locals: {} }).locals?.[slug] || {};
  return {
    color: GREEN,
    author: { name: `IBEW Local ${localNoOf(slug)} — ${l?.city || p.city}, ${l?.state || p.state}` },
    title: trunc(`${c.count}× ${c.classification} — ${ALL ? 'job call' : 'new job call'}`, 256),
    description: trunc(
      `${c.text}` + (jc.url ? `\n\n[full list](${jc.url}) · [view map](${siteUrl})` : `\n\n[view map](${siteUrl})`),
      4000,
    ),
    footer: { text: jc.posted ? `List posted ${jc.posted} · whichlocal` : 'whichlocal' },
    timestamp: new Date().toISOString(),
  };
}

/* ---------- run ------------------------------------------------------- */

async function createThread(forumId, slug) {
  const l = localBySlug.get(slug);
  const name = trunc(`IBEW Local ${localNoOf(slug)} — ${l?.city || place(slug).city}`, 100);
  const t = await discord('POST', `/channels/${forumId}/threads`, {
    name,
    message: { embeds: [compEmbed(slug)] },
  });
  return { thread: t.id, comp: t.id, calls: {} }; // forum starter message id == thread id
}

async function refreshComp(entry, slug, forumId) {
  try {
    await discord('PATCH', `/channels/${entry.thread}/messages/${entry.comp}`, { embeds: [compEmbed(slug)] });
    return entry;
  } catch (e) {
    // In comp-only mode never touch thread state — recreate/repin is the
    // job-calls run's job.
    if (COMP_ONLY && (e.status === 404 || e.status === 403)) {
      console.warn(`  ${slug}: comp refresh failed (${e.status}) — leaving it for the job-calls run`);
      return entry;
    }
    if (e.status === 404) {
      if (!forumId) throw new Error('thread gone and no forum to recreate it in');
      console.warn(`  ${slug}: thread/message gone — recreating`);
      return createThread(forumId, slug);
    }
    if (e.status === 403 || String(e.message).includes('50005')) {
      // comp message isn't ours to edit — post a fresh one and pin it
      const msg = await discord('POST', `/channels/${entry.thread}/messages`, { embeds: [compEmbed(slug)] });
      await discord('PUT', `/channels/${entry.thread}/pins/${msg.id}`).catch(() => {});
      return { thread: entry.thread, comp: msg.id, calls: entry.calls || {} };
    }
    throw e;
  }
}

let comps = 0;
let posts = 0;
let deletes = 0;
let skipped = 0;

for (const slug of slugs) {
  const calls = newCalls[slug] || [];
  const filled = filledCalls[slug] || [];
  const { state } = localBySlug.get(slug)
    ? { state: localBySlug.get(slug).state }
    : place(slug);
  const forumId = forums[normState(state)] || defaultChannel;
  let entry = entryOf(slug);

  if (COMP_ONLY && !entry) continue; // no thread yet — leave creation to job-calls.yml

  if (!entry && !forumId) {
    console.warn(`  ${slug}: no forum for ${normState(state)} and no default_channel_id — skipped${calls.length ? ` (${calls.length} new call[s])` : ''}`);
    skipped += 1;
    continue;
  }

  if (DRY) {
    const canDelete = entry ? filled.filter((id) => entry.calls[id]).length : 0;
    console.log(`  ${slug}: ${entry ? `refresh comp on ${entry.comp}` : `create thread in forum ${forumId} (comp card as starter)`}` +
      (calls.length ? ` · post ${calls.length} call message(s)` : '') +
      (canDelete ? ` · delete ${canDelete} filled-call message(s)` : ''));
    comps += 1;
    posts += calls.length;
    deletes += canDelete;
    continue;
  }

  try {
    if (!entry) {
      entry = await createThread(forumId, slug);
      console.log(`  ${slug}: created thread ${entry.thread}`);
    } else {
      const updated = await refreshComp(entry, slug, forumId);
      if (updated.thread !== entry.thread || updated.comp !== entry.comp) entry = updated;
    }
    if (!COMP_ONLY && threads[slug] !== entry) { threads[slug] = entry; threadsDirty = true; }
    comps += 1;

    for (const c of calls) {
      const msg = await discord('POST', `/channels/${entry.thread}/messages`, { embeds: [callEmbed(slug, c)] });
      if (c.id && msg.id) { entry.calls[c.id] = msg.id; threadsDirty = true; }
      posts += 1;
      await sleep(700);
    }

    // a call that vanished from the local's list → delete the message we posted
    for (const id of filled) {
      const msgId = entry.calls[id];
      if (!msgId) continue;
      try {
        await discord('DELETE', `/channels/${entry.thread}/messages/${msgId}`);
        deletes += 1;
      } catch (e) {
        if (e.status !== 404) console.warn(`  ${slug}: couldn't delete filled-call message ${msgId} (${e.status ?? e.message})`);
      }
      delete entry.calls[id];
      threadsDirty = true;
      await sleep(500);
    }
  } catch (e) {
    console.error(`  ${slug}: ${e.message}`);
    skipped += 1;
  }
  await sleep(400);
}

if (threadsDirty && !DRY) {
  writeFileSync(THREADS, JSON.stringify(threads, null, 2) + '\n');
}

console.log(
  `${DRY ? 'Would refresh' : 'Refreshed'} ${comps} comp card(s), ` +
  `${DRY ? 'post' : 'posted'} ${posts} job-call message(s), ` +
  `${DRY ? 'delete' : 'deleted'} ${deletes} filled-call message(s)` +
  `${skipped ? `, ${skipped} skipped` : ''}.`,
);
