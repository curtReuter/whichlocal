/**
 * Keep each local's Discord **forum thread** current:
 *   • the thread's opening post is a live compensation card (rebuilt every run
 *     from js/data/locals.json — Total package, hourly, pensions, COL, dues …);
 *   • new job calls are posted below it as individual messages;
 *   • when a listing's count/wording changes (e.g. 10 → 9 left), its message
 *     is edited in place;
 *   • when a call drops off the local's list, its message is deleted.
 *
 * Layout: one forum channel per state, one thread per local. The state → forum
 * map lives in scripts/discord-threads.json → `forums` ({ name, id } per state,
 * prefilled for every state). With scripts/job-calls.config.json → discord.guild_id
 * set (and, optionally, discord.category_id for the "Job Calls" category), the
 * bot CREATES the `<state>-job-calls` forum the first time a local in that state
 * has calls and records its id; job-calls.config.json → discord.forums (state →
 * id) is a fallback. Threads are saved to discord-threads.json as
 * { thread, comp, calls } — `comp` is the message the bot edits (the forum
 * starter message when the bot made the thread, otherwise a pinned bot message);
 * `calls` maps each posted job call's id to its Discord message id, so the
 * message can be removed when scrape-job-calls.mjs reports the call as gone.
 *
 *   node scripts/notify-discord.mjs
 *   node scripts/notify-discord.mjs --dry-run     # print what it would do
 *   node scripts/notify-discord.mjs --all         # also (re)post every current call
 *
 * Needs the repo secret DISCORD_BOT_TOKEN (bot invited with: View Channels,
 * Manage Channels, Send Messages, Send Messages in Threads, Create Public
 * Threads, Manage Messages, Embed Links, Read Message History). Missing token →
 * exits quietly. A local whose state has no forum (and no guild_id to make one)
 * falls back to discord.default_channel_id, else is skipped. Outbound only.
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
const legacyForums = cfg.discord?.forums || {};      // state -> id, fallback only
const defaultChannel = cfg.discord?.default_channel_id || '';
const guildId = cfg.discord?.guild_id || '';         // needed to auto-create forums
const categoryId = cfg.discord?.category_id || '';   // the "Job Calls" category new forums go under

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
// job calls whose wording/count changed on the same listing (e.g. 10 → 9 left)
// → the existing message is edited in place (slug → [call, …], each with
// prev_id / prev_count). Not in --comp-only or --all.
let editedCalls = {};
if (!COMP_ONLY && !ALL && existsSync(DELTA)) {
  const d = readJson(DELTA, { filled: {}, edited: {} });
  filledCalls = Object.fromEntries(Object.entries(d.filled || {}).map(([s, f]) => [s, f.ids || []]));
  editedCalls = Object.fromEntries(Object.entries(d.edited || {}).map(([s, e]) => [s, e.calls || []]));
}

const threads = readJson(THREADS, {});
let threadsDirty = false;
// persist immediately after every forum create/move — a run that times out
// mid-way must not lose the new channel ids and re-create them next time
const saveThreads = () => {
  if (!DRY) writeFileSync(THREADS, JSON.stringify(threads, null, 2) + '\n');
  threadsDirty = false;
};
const entryOf = (slug) => {
  const v = threads[slug];
  if (!v) return null;
  const e = typeof v === 'string' ? { thread: v, comp: v } : v; // migrate legacy string form
  if (!e.calls) e.calls = {}; // callId → Discord message id
  return e;
};

// state code → { name, id } forum registry, prefilled for every state in
// discord-threads.json. Migrate any id still only in job-calls.config.json.
const forumsMap = threads.forums || (threads.forums = {});
for (const [st, id] of Object.entries(legacyForums)) {
  if (id && forumsMap[st] && !forumsMap[st].id) { forumsMap[st].id = id; threadsDirty = true; }
}
if (!DRY) {
  const have = Object.values(forumsMap).filter((f) => f && f.id).length;
  console.log(`Discord: guild ${guildId || '(unset)'}, category ${categoryId || '(unset)'}, ${have}/${Object.keys(forumsMap).length} state forums have an id`);
}

// Resolve (and, when guild_id is set + the bot may write, CREATE) the forum
// channel for a state. The `<state>-job-calls` forum is made once, then its id
// is recorded in discord-threads.json. Discord rate-limits channel creation
// hard, so cap creates per run — the rest get made on the next 2-hourly run,
// so a full roll-out spreads over a few runs instead of timing out.
let forumBudget = Number(process.env.FORUM_CREATE_BUDGET || 8);
let liveChannelIds = null; // Set of the guild's channel ids, once fetched below
const forumAlive = (id) => id && (!liveChannelIds || liveChannelIds.has(id));
async function resolveForum(st) {
  const fe = forumsMap[st];
  if (fe && forumAlive(fe.id)) return fe.id;
  if (forumAlive(legacyForums[st])) return legacyForums[st];
  const canCreate = fe && fe.name && guildId;
  if (canCreate && DRY) return `(new #${fe.name})`;
  if (canCreate && !COMP_ONLY && BOT_TOKEN && forumBudget > 0) {
    const payload = { name: fe.name, type: 15 };     // 15 = GUILD_FORUM
    if (categoryId) payload.parent_id = categoryId;
    try {
      const ch = await discord('POST', `/guilds/${guildId}/channels`, payload);
      fe.id = ch.id;
      if (categoryId) fe.parent = ch.parent_id || categoryId;
      saveThreads();
      forumBudget -= 1;
      const where = ch.parent_id ? `under ${ch.parent_id}` : 'at server root';
      console.log(`  + created forum #${fe.name} (${ch.id}) for ${st} ${where}${forumBudget === 0 ? ' — budget reached, more next run' : ''}`);
      await sleep(2500); // stay well under the channel-create rate limit
      return ch.id;
    } catch (e) {
      forumBudget = 0; // rate-limited or no permission — stop trying this run
      console.warn(`  ${st}: create forum #${fe.name} FAILED — ${e.message}`);
    }
  }
  return defaultChannel || '';
}

if (!DRY && !BOT_TOKEN) {
  console.warn('DISCORD_BOT_TOKEN not set — skipping.');
  process.exit(0);
}

const slugs = [...new Set([
  ...Object.keys(cfg).filter((k) => /^l\d/.test(k)),
  ...Object.keys(newCalls).filter((s) => newCalls[s].length),
  ...Object.keys(filledCalls).filter((s) => filledCalls[s].length),
  ...Object.keys(editedCalls).filter((s) => editedCalls[s].length),
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
  // No title — the thread is already named "Local N — City".
  const l = localBySlug.get(slug);

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
    description:
      'Journeyman compensation for this local. New job calls appear below as they’re listed.\n\n' +
      links.join(' · '),
    fields: fields.length ? fields : undefined,
    footer: { text: l?.source_updated ? `Wage data updated ${l.source_updated} · whichlocal` : 'whichlocal' },
    timestamp: new Date().toISOString(),
  };
}

// A second, minimal embed so the call-to-action renders *below* the comp
// card's footer — the very bottom of the starter message.
const FOLLOW_EMBED = { color: BLUE, description: '**FOLLOW FOR NOTIFICATIONS** ⬇️⬇️⬇️' };
const compMessage = (slug) => ({ embeds: [compEmbed(slug), FOLLOW_EMBED] });

function callEmbed(slug, c) {
  // No local header — every call message is posted inside that local's own thread.
  const jc = readJson(FULL, { locals: {} }).locals?.[slug] || {};
  const kind = c.prev_id ? 'job call updated' : ALL ? 'job call' : 'new job call';
  const countNote =
    c.prev_id && typeof c.prev_count === 'number' && c.prev_count !== c.count
      ? `\n\n_${c.prev_count}× → ${c.count}× ${c.classification}_`
      : '';
  const links = jc.url
    ? `\n\n[full list](${jc.url}) · [view map](${siteUrl})`
    : `\n\n[view map](${siteUrl})`;
  return {
    color: GREEN,
    title: trunc(`${c.count}× ${c.classification} — ${kind}`, 256),
    description: trunc(`${c.text}${countNote}${links}`, 4000),
    footer: { text: jc.posted ? `List posted ${jc.posted} · whichlocal` : 'whichlocal' },
    timestamp: new Date().toISOString(),
  };
}

/* ---------- run ------------------------------------------------------- */

async function createThread(forumId, slug) {
  const l = localBySlug.get(slug);
  const name = trunc(`Local ${localNoOf(slug)} — ${l?.city || place(slug).city}`, 100);
  const t = await discord('POST', `/channels/${forumId}/threads`, {
    name,
    message: compMessage(slug),
  });
  return { thread: t.id, comp: t.id, calls: {} }; // forum starter message id == thread id
}

async function refreshComp(entry, slug, forumId) {
  try {
    await discord('PATCH', `/channels/${entry.thread}/messages/${entry.comp}`, compMessage(slug));
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
      const msg = await discord('POST', `/channels/${entry.thread}/messages`, compMessage(slug));
      await discord('PUT', `/channels/${entry.thread}/pins/${msg.id}`).catch(() => {});
      return { thread: entry.thread, comp: msg.id, calls: entry.calls || {} };
    }
    throw e;
  }
}

// Sync the forum registry to what's actually in the guild:
//   • adopt a `<state>-job-calls` forum that exists but whose id we don't have
//   • forget a recorded id whose channel was deleted (and drop that state's
//     stale local-thread rows) so it gets rebuilt
if (guildId && !DRY && !COMP_ONLY && BOT_TOKEN) {
  try {
    const list = await discord('GET', `/guilds/${guildId}/channels`);
    const liveById = new Map(list.map((c) => [c.id, c]));
    liveChannelIds = new Set(liveById.keys()); // resolveForum now rejects dead ids
    const forumByName = new Map(list.filter((c) => c.type === 15).map((c) => [c.name, c]));
    const stateOf = (slug) => normState((localBySlug.get(slug) || place(slug)).state);

    let adopted = 0;
    let dropped = 0;
    for (const [st, fe] of Object.entries(forumsMap)) {
      if (!fe || !fe.name) continue;
      if (fe.id && !liveById.has(fe.id)) {          // recorded forum is gone
        fe.id = '';
        fe.parent = null;
        dropped += 1;
        for (const slug of Object.keys(threads)) {
          if (/^l\d/.test(slug) && stateOf(slug) === st) delete threads[slug];
        }
      }
      if (!fe.id) {                                  // fill from a live forum of the same name
        const found = forumByName.get(fe.name);
        if (found) { fe.id = found.id; fe.parent = found.parent_id || null; adopted += 1; }
      }
    }
    if (adopted || dropped) {
      saveThreads();
      console.log(`Forum sync: adopted ${adopted}, cleared ${dropped} deleted.`);
    }
  } catch (e) {
    console.warn(`  couldn't list guild channels to sync forums — ${e.message}`);
  }
}

// Reconcile: move any state forum that isn't yet under the Job Calls category.
if (categoryId && !DRY && !COMP_ONLY && BOT_TOKEN) {
  const stray = Object.entries(forumsMap).filter(([, fe]) => fe && fe.id && fe.parent !== categoryId);
  if (stray.length) console.log(`Filing ${stray.length} forum(s) under category ${categoryId}…`);
  let moveBudget = 20;
  for (const [st, fe] of stray) {
    if (moveBudget <= 0) break;
    try {
      const ch = await discord('PATCH', `/channels/${fe.id}`, { parent_id: categoryId });
      fe.parent = ch.parent_id || categoryId;
      saveThreads();
      moveBudget -= 1;
      console.log(`  ~ #${fe.name || st} → parent ${ch.parent_id || '(none returned!)'}`);
      await sleep(700);
    } catch (e) {
      console.warn(`  ${st}: move #${fe.name || st} into category FAILED — ${e.message}`);
      break;
    }
  }
}

let comps = 0;
let posts = 0;
let edits = 0;
let deletes = 0;
let skipped = 0;

for (const slug of slugs) {
  const calls = newCalls[slug] || [];
  const filled = filledCalls[slug] || [];
  const edited = editedCalls[slug] || [];
  const { state } = localBySlug.get(slug)
    ? { state: localBySlug.get(slug).state }
    : place(slug);
  let entry = entryOf(slug);

  if (COMP_ONLY && !entry) continue; // no thread yet — leave creation to job-calls.yml

  const forumId = await resolveForum(normState(state));

  if (!entry && !forumId) {
    console.warn(`  ${slug}: no forum for ${normState(state)} — add discord.guild_id (auto-create) or a channel id, or a default_channel_id — skipped${calls.length ? ` (${calls.length} new call[s])` : ''}`);
    skipped += 1;
    continue;
  }

  if (DRY) {
    const canDelete = entry ? filled.filter((id) => entry.calls[id]).length : 0;
    const canEdit = entry ? edited.filter((c) => c.prev_id && entry.calls[c.prev_id]).length : 0;
    console.log(`  ${slug}: ${entry ? `refresh comp on ${entry.comp}` : `create thread in forum ${forumId} (comp card as starter)`}` +
      (calls.length ? ` · post ${calls.length} call message(s)` : '') +
      (canEdit ? ` · edit ${canEdit} changed-call message(s)` : '') +
      (canDelete ? ` · delete ${canDelete} filled-call message(s)` : ''));
    comps += 1;
    posts += calls.length;
    edits += canEdit;
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

    // a listing whose count/wording changed → edit its message in place, then
    // re-key entry.calls from the old text-hash to the new one
    for (const c of edited) {
      const msgId = c.prev_id && entry.calls[c.prev_id];
      if (!msgId) {
        // we never posted the original — treat it as a new call
        const msg = await discord('POST', `/channels/${entry.thread}/messages`, { embeds: [callEmbed(slug, c)] });
        if (c.id && msg.id) { entry.calls[c.id] = msg.id; threadsDirty = true; }
        posts += 1;
        await sleep(700);
        continue;
      }
      try {
        await discord('PATCH', `/channels/${entry.thread}/messages/${msgId}`, { embeds: [callEmbed(slug, c)] });
        edits += 1;
        if (c.id) entry.calls[c.id] = msgId;
        if (c.prev_id !== c.id) delete entry.calls[c.prev_id];
        threadsDirty = true;
      } catch (e) {
        if (e.status === 404) {
          const msg = await discord('POST', `/channels/${entry.thread}/messages`, { embeds: [callEmbed(slug, c)] });
          if (c.id && msg.id) entry.calls[c.id] = msg.id;
          if (c.prev_id !== c.id) delete entry.calls[c.prev_id];
          posts += 1;
          threadsDirty = true;
        } else {
          console.warn(`  ${slug}: couldn't edit changed-call message ${msgId} (${e.status ?? e.message})`);
        }
      }
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
  `${DRY ? 'edit' : 'edited'} ${edits} changed-call message(s), ` +
  `${DRY ? 'delete' : 'deleted'} ${deletes} filled-call message(s)` +
  `${skipped ? `, ${skipped} skipped` : ''}.`,
);
