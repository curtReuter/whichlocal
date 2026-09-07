/**
 * Post a Discord message for every job call that turned up new in the last
 * `scrape-job-calls.mjs` run (it writes scripts/cache/job-calls-delta.json).
 *
 *   node scripts/notify-discord.mjs
 *   node scripts/notify-discord.mjs --dry-run     # print payloads, post nothing
 *   node scripts/notify-discord.mjs --all         # post EVERY current call (test)
 *
 * Destination — set ONE of these (repo secrets in CI):
 *   • DISCORD_WEBHOOK_URL                       — a channel webhook (simplest)
 *   • DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID    — post as the bot application
 *
 * With neither set it exits quietly (so the workflow works before you add
 * secrets). Outbound only — this never opens a gateway connection or handles
 * slash commands, so it runs fine as a one-shot GitHub Action.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DELTA = join(ROOT, 'scripts', 'cache', 'job-calls-delta.json');
const FULL = join(ROOT, 'js', 'data', 'job-calls.json');
const DRY = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all') || process.env.NOTIFY_ALL === '1';

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const useBot = Boolean(BOT_TOKEN && CHANNEL_ID);

const GREEN = 0x12905a;
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const place = (slug) => {
  const parts = slug.replace(/^l\d+-/, '').split('-');
  const state = (parts.pop() || '').toUpperCase();
  return { city: parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), state };
};

// `--all` posts every current call from js/data/job-calls.json (one-off test);
// otherwise only calls new since the last scrape (from the run delta).
let added;
if (ALL) {
  if (!existsSync(FULL)) { console.log('No js/data/job-calls.json.'); process.exit(0); }
  const locals = JSON.parse(readFileSync(FULL, 'utf8')).locals || {};
  added = Object.fromEntries(Object.entries(locals).map(([slug, l]) =>
    [slug, { local_no: l.local_no, url: l.url, posted: l.posted, ...place(slug), calls: l.calls || [] }]));
} else {
  if (!existsSync(DELTA)) {
    console.log('No job-calls-delta.json — run scrape-job-calls.mjs first. Nothing to send.');
    process.exit(0);
  }
  added = JSON.parse(readFileSync(DELTA, 'utf8')).added || {};
}

const slugs = Object.keys(added).filter((s) => (added[s].calls || []).length);
if (!slugs.length) {
  console.log(ALL ? 'No job calls at all.' : 'No new job calls.');
  process.exit(0);
}
if (!DRY && !useBot && !WEBHOOK) {
  console.warn('No Discord destination configured — set DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN+DISCORD_CHANNEL_ID. Skipping.');
  process.exit(0);
}

function embedsFor(slug) {
  const l = added[slug];
  const who = `IBEW Local ${l.local_no}${l.city ? ` — ${l.city}, ${l.state}` : ''}`;
  return l.calls.map((c) => ({
    color: GREEN,
    author: { name: who },
    title: trunc(`${c.count}× ${c.classification} — ${ALL ? 'job call' : 'new job call'}`, 256),
    description: trunc(c.text, 3900) + (c.open_until_filled ? '\n\n**OPEN UNTIL FILLED**' : ''),
    url: l.url,
    footer: { text: l.posted ? `List posted ${l.posted} · whichlocal` : 'whichlocal' },
    timestamp: new Date().toISOString(),
  }));
}

async function post(payload) {
  const url = useBot
    ? `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`
    : WEBHOOK;
  const headers = { 'Content-Type': 'application/json' };
  if (useBot) headers.Authorization = `Bot ${BOT_TOKEN}`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (res.status === 429) {
      const wait = ((await res.json().catch(() => ({}))).retry_after ?? 1) * 1000 + 300;
      console.warn(`rate limited — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
    return;
  }
  throw new Error('gave up after repeated 429s');
}

let sent = 0;
for (const slug of slugs) {
  const embeds = embedsFor(slug);
  for (let i = 0; i < embeds.length; i += 10) {        // Discord: ≤ 10 embeds / message
    const payload = { embeds: embeds.slice(i, i + 10) };
    if (DRY) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      await post(payload);
      await new Promise((r) => setTimeout(r, 900));
    }
    sent += payload.embeds.length;
  }
}
console.log(`${DRY ? 'Would send' : 'Sent'} ${sent} new job-call notification(s) across ${slugs.length} local(s)` +
  `${DRY ? '' : useBot ? ' (as the bot)' : ' (via webhook)'}.`);
