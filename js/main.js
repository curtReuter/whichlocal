/**
 * main.js — glue between the data source (PocketBase, via dataSource.js), the
 * map module (cityMap.js) and the page chrome (metric picker, ranked list,
 * footer readout). Everything data-specific lives here; cityMap.js stays generic.
 */

// ?v= must match index.html — bump both together on any frontend change so
// browsers don't serve a stale module past GitHub Pages' 10-minute cache.
import { metrics } from './metrics.js?v=54';
import { loadLocals, loadJobCalls, loadRoster } from './dataSource.js?v=54';
import { createCityMap } from './cityMap.js?v=54';

// Runtime config (CARTO key + PocketBase URL), resolved in order:
//   1. js/config.local.js  — gitignored local overrides (e.g. pointing at a live
//      PocketBase for dev); optional.
//   2. js/config.js        — the committed default the deployed site uses:
//      the publishable CARTO key + an empty pocketbaseUrl, so the app reads the
//      js/data/locals.json snapshot.
let config = { cartoApiKey: '', pocketbaseUrl: '' };
try {
  ({ config } = await import('./config.local.js'));
} catch {
  try {
    ({ config } = await import('./config.js'));
  } catch {
    console.info('No js/config.local.js or js/config.js — using built-in defaults.');
  }
}

// Pull the IBEW locals from PocketBase up front. On failure the app still
// renders; the list shows why.
let locals = [];
let loadError = null;
try {
  locals = await loadLocals(config.pocketbaseUrl);
} catch (e) {
  loadError = e.message;
  console.error(e);
}

// Fold in every other IBEW local from the DOL OLMS roster — the ones we have no
// wage data for. They ride along as `dataless` locals: a small grey dot on the
// map, a minimal detail panel, no place in the ranked list.
try {
  const haveNo = new Set(locals.map((l) => l.local_no));
  for (const r of await loadRoster()) {
    if (haveNo.has(r.local_no) || !r.lat || !r.lng) continue;
    locals.push({
      id: r.slug,
      local_no: r.local_no,
      name: `IBEW Local ${r.local_no}`,
      subtitle: [r.city, r.state].filter(Boolean).join(', '),
      lat: r.lat,
      lng: r.lng,
      values: {},
      dataless: true,
    });
  }
} catch (e) {
  console.warn('roster merge skipped:', e.message);
}

// Locals in the same city geocode to identical coordinates (St. Louis has 5,
// Tampa 3, …) and stack into a single dot — the ones underneath can't be seen or
// clicked. Fan each such cluster out into a small ring around its shared point so
// every member has its own hover/click target; one zoom step separates them
// fully. ~0.3° between neighbours keeps each local inside its own metro.
function disperseCoincident(list) {
  const NEIGHBOUR_DEG = 0.3;
  const groups = new Map();
  for (const c of list) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    const key = `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    members.sort((a, b) => (a.local_no || 0) - (b.local_no || 0));
    const n = members.length;
    const lat0 = members.reduce((s, c) => s + c.lat, 0) / n;
    const lng0 = members.reduce((s, c) => s + c.lng, 0) / n;
    const r = NEIGHBOUR_DEG / (2 * Math.sin(Math.PI / n));
    const lngScale = Math.max(0.25, Math.cos((lat0 * Math.PI) / 180));
    // deterministic phase so pairs/triangles don't all point the same way
    const phase = ((parseInt(key.replace(/\D/g, '').slice(-4), 10) || 0) % 360) * Math.PI / 180;
    members.forEach((c, i) => {
      const a = phase + (2 * Math.PI * i) / n;
      c.lat = lat0 + r * Math.sin(a);
      c.lng = lng0 + (r * Math.cos(a)) / lngScale;
    });
  }
}
disperseCoincident(locals);

// id → full local (all metric values, wage-sheet URL, source date) for the
// expanding detail panel.
const localById = new Map(locals.map((c) => [c.id, c]));

// slug → { total, calls[], posted, … } for the locals that publish a job-calls
// list. Optional; empty when js/data/job-calls.json isn't present.
const jobCalls = await loadJobCalls();

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

const els = {
  select: document.getElementById('metric-select'),
  modeToggle: document.getElementById('mode-toggle'),
  modeNote: document.getElementById('mode-note'),
  list: document.getElementById('city-list'),
  panelTitle: document.getElementById('panel-title'),
  sortToggle: document.getElementById('sort-toggle'),
  sortLabel: document.getElementById('sort-label'),
  readout: document.getElementById('readout'),
};

const state = {
  metricId: 'job_calls',   // default view: locals ranked by open job calls
  sortDesc: true,
  selectedId: null,
  // Which face of the green detail panel shows: 'comp' | 'jobs' | 'edit' | 'addcall'.
  detailView: 'comp',
  // where a submission form was opened from, so its "Back" returns there.
  detailReturn: 'comp',
  // "Compare" mode: divide the chosen metric by local cost of living, so values
  // read as national-average dollars (how far the pay actually goes).
  compare: false,
};

const jobCallCount = (slug) => (jobCalls[slug] ? jobCalls[slug].total : null);
const jobCallLabel = (n) => `${n} job call${n === 1 ? '' : 's'}`;

// Where the "Edit Data" / "Add Job Call" / "Flag filled" forms submit:
//   config.submitUrl    — a Cloudflare Worker that opens a GitHub issue and
//                         stores the wage-sheet upload in R2 (worker/); preferred.
//   config.web3formsKey  — fall back to Web3Forms → email.
// The submission buttons show when either is configured.
const SUBMIT_URL = (config.submitUrl || '').trim();
const CONTRIB_KEY = (config.web3formsKey || '').trim();
const CAN_SUBMIT = Boolean(SUBMIT_URL || CONTRIB_KEY);
// hCaptcha sitekey. With the Worker, set config.hcaptchaSitekey to your own
// site's key (its secret lives in the Worker). Default = Web3Forms' shared key.
const HCAPTCHA_SITEKEY =
  (config.hcaptchaSitekey || '').trim() || '50b2fe65-b00b-4b9e-ad62-3ba471098be2';

// Contiguous US — the first-load view. Panning to AK / HI / Canada still works
// (the map's maxBounds is the wider North-America box).
const US_BOUNDS = [[25.5, -123.5], [48.5, -67]];

const mqMobile = window.matchMedia('(max-width: 820px)');

// Hotspot circle sizes scale with the map's own width, so they stay readable on
// a phone and don't crowd the map on a laptop. Anchored to #map (the ranked
// list eats into the window on desktop), clamped so extremes stay sane.
function hotspotRadii() {
  const w = document.querySelector('#map')?.clientWidth || window.innerWidth;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const jobs = state.metricId === 'job_calls';
  return {
    // job-call counts are small integers with a narrow spread, so a tight range
    // keeps a 12-call local from ballooning into a blob that hides its
    // neighbours; wage metrics span a wide range and want the full scale
    minRadius: jobs ? clamp(w / 130, 8, 12) : clamp(w / 170, 4, 9),
    maxRadius: jobs ? clamp(w / 70, 14, 22) : clamp(w / 45, 15, 40),
    // roster-only greys elsewhere are a faint speck so they don't swamp the
    // coloured data; on the job-calls view they ARE the data (every local with
    // no open calls), so show them a bit bigger there — but not much
    datalessRadius: jobs ? clamp(w / 175, 4, 7) : clamp(w / 380, 1.6, 4),
  };
}

// re-apply the width- and metric-aware circle sizes and redraw
function syncRadii() {
  const { minRadius, maxRadius, datalessRadius } = hotspotRadii();
  map.setRadii(minRadius, maxRadius, datalessRadius);
}

const map = createCityMap('#map', {
  theme: prefersDark ? 'dark' : 'light',
  center: [39.5, -98], // continental US; refined to US_BOUNDS on load
  zoom: 4,
  minZoom: 3,
  cartoApiKey: config.cartoApiKey || '',
  ...hotspotRadii(),
});

// keep the circle scale in step with the viewport (device rotation, window drag)
let radiiTimer;
window.addEventListener('resize', () => {
  clearTimeout(radiiTimer);
  radiiTimer = setTimeout(syncRadii, 200);
});

// On phones, tuck the map attribution into the bottom-left corner and drop the
// "Leaflet" prefix so it's a tiny unobtrusive line (CSS shrinks the type).
const L = window.L;
const DEFAULT_ATTR_PREFIX = L.Control.Attribution.prototype.options.prefix;
function placeAttribution() {
  const ac = map.leaflet.attributionControl;
  ac.setPosition(mqMobile.matches ? 'bottomleft' : 'bottomright');
  ac.setPrefix(mqMobile.matches ? false : DEFAULT_ATTR_PREFIX);
}
placeAttribution();
mqMobile.addEventListener('change', placeAttribution);

/* ---- populate the metric <select> ------------------------------------- */

for (const [id, meta] of Object.entries(metrics)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = meta.label;
  els.select.appendChild(opt);
}

// Default to the job-calls view; fall back to total package if no local has a
// job-calls list yet (so the app still shows something on first load).
if (state.metricId === 'job_calls' && Object.keys(jobCalls).length === 0) {
  state.metricId = 'total_package';
}
els.select.value = state.metricId;

/* ---- build the {id,name,subtitle,lat,lng,value} points for a metric --- */

function pointsForMetric(metricId) {
  const isJobs = metricId === 'job_calls';
  return locals
    .map((c) => {
      const n = jobCallCount(c.id);
      const base = { id: c.id, name: c.name, subtitle: c.subtitle, lat: c.lat, lng: c.lng };
      const grey = { ...base, value: null, dataless: true, tp: null };

      if (isJobs) {
        // the whole roster shows on the job-calls view: a green dot with the
        // count for locals that have calls, a grey "no calls" dot for the rest
        return n != null
          ? { ...base, value: n, badge: jobCallLabel(n), hideValue: true, tp: c.values.total_package }
          : { ...grey, note: 'no job calls available' };
      }

      // roster-only local: a grey dot on any wage metric
      if (c.dataless) return { ...grey, badge: n != null ? jobCallLabel(n) : null };

      let value = c.values[metricId];
      if (!Number.isFinite(value)) return null;
      if (state.compare) {
        // divide by cost of living (as a fraction of the national average)
        const col = c.values.col_pct;
        if (!Number.isFinite(col) || col <= 0) return null;
        value /= col / 100;
      }
      return {
        ...base, value,
        // green "N job calls" tooltip line for any local that has calls
        badge: n != null ? jobCallLabel(n) : null,
        tp: c.values.total_package, // shown in the list when metric = job_calls
      };
    })
    .filter(Boolean);
}

/* ---- ranked locals list ------------------------------------------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderMessage(text) {
  els.list.innerHTML = `<li class="city-list__empty">${text}</li>`;
}

// The green panel that expands under the selected local. Views: the compensation
// grid ('comp'), the local's job-calls list ('jobs'), the submission forms
// ('edit' / 'addcall' / 'delcall' — the last flags listed calls as filled), or —
// for a roster-only local — a short "no wage data" note plus its job calls.
function buildDetail(local) {
  if (!local) return '';
  const jc = jobCalls[local.id];
  // on the job-calls view, a local with no calls gets a plain-language line
  const noCallsNote =
    state.detailView !== 'edit' && state.detailView !== 'addcall' &&
    state.metricId === 'job_calls' && !jc
      ? '<p class="detail__notice">No job calls available for this local right now.</p>'
      : '';
  let body;
  if (state.detailView === 'edit') {
    body = buildEditView(local);
  } else if (state.detailView === 'addcall') {
    body = buildAddCallView(local);
  } else if (state.detailView === 'delcall' && jc) {
    body = buildDelCallView(local, jc);
  } else if (local.dataless) {
    body =
      noCallsNote +
      '<p class="detail__nodata">No wage data for this local yet — only locals with a ' +
      'published wage sheet have figures. It’s on the map so it can still be found.</p>' +
      (jc ? buildJobsView(jc, { noBack: true }) : '') +
      (CAN_SUBMIT ? `<div class="detail__foot">${CONTRIB_BUTTONS}</div>` : '');
  } else if (state.detailView === 'jobs' && jc) {
    body = buildJobsView(jc);
  } else {
    body = noCallsNote + buildCompView(local);
  }
  return (
    '<div class="city-list__detail"><div class="detail__inner">' +
      '<button type="button" class="detail__close" aria-label="Close details">×</button>' +
      body +
    '</div></div>'
  );
}

function buildCompView(local) {
  const cells = [];
  for (const [id, m] of Object.entries(metrics)) {
    const v = local.values[id];
    if (!Number.isFinite(v)) continue;
    cells.push(
      '<div class="detail__cell">' +
        `<span class="detail__k">${esc(m.label)}</span>` +
        `<span class="detail__v">${esc(m.format(v))}</span>` +
      '</div>',
    );
  }

  const foot = [];
  if (local.sourceUpdated) {
    foot.push(`<span title="Wage data last updated">Updated ${esc(local.sourceUpdated)}</span>`);
  }
  if (local.wageSheetUrl) {
    foot.push(
      `<a href="${esc(local.wageSheetUrl)}" target="_blank" rel="noopener">Wage sheet&nbsp;↗</a>`,
    );
  }
  if (CAN_SUBMIT) foot.push(CONTRIB_BUTTONS);

  return (
    `<div class="detail__grid">${cells.join('')}</div>` +
    (foot.length ? `<div class="detail__foot">${foot.join('')}</div>` : '')
  );
}

// the "Edit Data" / "Add Job Call" pair, sharing the compensation view's footer
const CONTRIB_BUTTONS =
  '<span class="detail__footacts">' +
    '<button type="button" class="detail__go detail__go--edit">Edit Data</button>' +
    '<button type="button" class="detail__go detail__go--call">Add Job Call</button>' +
  '</span>';

const CONTRIB_METRICS = Object.entries(metrics).filter(([id]) => id !== 'job_calls');

// hCaptcha widget + honeypot + status line shared by both submission forms
const FORM_TAIL =
  '<input type="checkbox" name="botcheck" class="detail__hp" tabindex="-1" autocomplete="off">' +
  '<div class="detail__captcha"></div>' +
  '<div class="detail__formfoot">' +
    '<button type="button" class="detail__link detail__formcancel">←&nbsp;Back</button>' +
    '<button type="submit" class="detail__go detail__submit">Submit for review</button>' +
  '</div>' +
  '<p class="detail__formstatus" hidden></p>';

// render (or re-render) the hCaptcha checkbox in a freshly-built form. api.js is
// loaded async, so retry until window.hcaptcha is ready.
function renderCaptcha(form) {
  const el = form && form.querySelector('.detail__captcha');
  if (!el || el.dataset.wid || !el.isConnected) return;
  if (window.hcaptcha && window.hcaptcha.render) {
    try { el.dataset.wid = window.hcaptcha.render(el, { sitekey: HCAPTCHA_SITEKEY }); }
    catch { /* already rendered */ }
  } else {
    setTimeout(() => renderCaptcha(form), 250);
  }
}
function resetCaptcha(form) {
  const wid = form && form.querySelector('.detail__captcha')?.dataset.wid;
  if (wid && window.hcaptcha) { try { window.hcaptcha.reset(wid); } catch { /* gone */ } }
}

function buildEditView(local) {
  const rows = CONTRIB_METRICS.map(([id, m]) => {
    const v = local.values[id];
    return (
      '<label class="detail__f">' +
        `<span class="detail__k">${esc(m.label)}</span>` +
        `<input class="detail__in" type="number" step="0.01" inputmode="decimal" name="m_${id}" ` +
          `value="${Number.isFinite(v) ? v : ''}" placeholder="${Number.isFinite(v) ? '' : '—'}">` +
      '</label>'
    );
  }).join('');
  return (
    '<form class="detail__form" data-kind="edit">' +
      `<p class="detail__formhead">Suggest a correction for <strong>${esc(local.name)}</strong> — ` +
        `${esc(local.subtitle)}. Change any figures, attach the wage sheet, or both — it’s emailed for review.</p>` +
      `<div class="detail__fgrid">${rows}</div>` +
      '<label class="detail__f detail__f--wide">' +
        '<span class="detail__k">Wage sheet — PDF or image (optional)</span>' +
        '<input class="detail__in" type="file" name="wage_sheet" accept=".pdf,image/*">' +
      '</label>' +
      '<label class="detail__f detail__f--wide">' +
        '<span class="detail__k">Notes (optional)</span>' +
        '<textarea class="detail__in" name="notes" rows="2" placeholder="Effective date, where you got this, anything else"></textarea>' +
      '</label>' +
      FORM_TAIL +
    '</form>'
  );
}

function buildAddCallView(local) {
  return (
    '<form class="detail__form" data-kind="jobcall">' +
      `<p class="detail__formhead">Add a job call for <strong>${esc(local.name)}</strong> — ` +
        `${esc(local.subtitle)}. Paste the posting as the local listed it — it’s emailed for review.</p>` +
      '<label class="detail__f detail__f--wide">' +
        '<span class="detail__k">Job call details</span>' +
        '<textarea class="detail__in" name="call" rows="6" required ' +
          'placeholder="e.g. 3 Journeyman Wireman calls for … — hours, scale, reporting instructions"></textarea>' +
      '</label>' +
      '<label class="detail__f detail__f--wide">' +
        '<span class="detail__k">Source link (optional)</span>' +
        '<input class="detail__in" type="url" name="source" placeholder="https://…">' +
      '</label>' +
      FORM_TAIL +
    '</form>'
  );
}

function buildDelCallView(local, jc) {
  const items = jc.calls.map((c, i) => (
    '<label class="detail__delitem">' +
      `<input type="checkbox" name="del" value="${i}">` +
      `<span>${esc(c.text)}</span>` +
    '</label>'
  )).join('');
  return (
    '<form class="detail__form" data-kind="delcall">' +
      `<p class="detail__formhead">Flag job calls at <strong>${esc(local.name)}</strong> — ` +
        `${esc(local.subtitle)} that are filled or no longer posted. Checked calls are emailed for review.</p>` +
      `<div class="detail__dellist">${items}</div>` +
      '<label class="detail__f detail__f--wide">' +
        '<span class="detail__k">Notes (optional)</span>' +
        '<textarea class="detail__in" name="notes" rows="2" placeholder="How do you know these are gone?"></textarea>' +
      '</label>' +
      FORM_TAIL +
    '</form>'
  );
}

function setFormStatus(el, kind, msg) {
  el.hidden = false;
  el.textContent = msg;
  el.className = 'detail__formstatus' + (kind ? ` detail__formstatus--${kind}` : '');
}

async function submitContribution(form, local) {
  if (!local || form.querySelector('[name=botcheck]').checked) return; // bot
  const kind = form.dataset.kind;
  const status = form.querySelector('.detail__formstatus');
  const submit = form.querySelector('.detail__submit');

  const captcha = form.querySelector('[name="h-captcha-response"]')?.value || '';
  if (!captcha) {
    setFormStatus(status, 'error', 'Please complete the “I am human” check first.');
    return;
  }

  const fd = new FormData();
  fd.append('h-captcha-response', captcha);
  fd.append('kind', kind);
  fd.append('local', `IBEW Local ${local.local_no} — ${local.subtitle}`);
  fd.append('local_slug', local.id);
  fd.append('local_no', String(local.local_no ?? ''));
  fd.append('page', location.href);
  if (!SUBMIT_URL) { // Web3Forms wants these; the Worker ignores them
    fd.append('access_key', CONTRIB_KEY);
    fd.append('from_name', 'Which Local — visitor submission');
  }

  if (kind === 'edit') {
    fd.append('subject', `Wage edit — Local ${local.local_no} (${local.subtitle})`);
    const changes = [];
    const changed = {};
    for (const [id, m] of CONTRIB_METRICS) {
      const inp = form.querySelector(`[name="m_${id}"]`);
      if (!inp || inp.value.trim() === '') continue;
      const next = Number(inp.value);
      if (!Number.isFinite(next)) continue;
      const now = local.values[id];
      if (next !== now) {
        changes.push(`${m.label}: ${Number.isFinite(now) ? now : '—'} → ${next}`);
        changed[id] = next;
      }
    }
    const notes = form.querySelector('[name=notes]').value.trim();
    const file = form.querySelector('[name=wage_sheet]').files[0];
    if (file && file.size > 9 * 1024 * 1024) {
      setFormStatus(status, 'error', 'That file is over 9 MB — attach a smaller one or link it in Notes.');
      return;
    }
    if (!changes.length && !notes && !file) {
      setFormStatus(status, 'error', 'Change a figure, add a note, or attach a wage sheet first.');
      return;
    }
    fd.append('proposed_changes', changes.length ? changes.join('\n') : '(no figure edits — see notes / wage sheet)');
    fd.append('changes_json', JSON.stringify(changed));
    fd.append('notes', notes);
    if (file) fd.append('wage_sheet', file, file.name);
  } else if (kind === 'delcall') {
    const calls = (jobCalls[local.id] || { calls: [] }).calls;
    const picked = [...form.querySelectorAll('[name=del]:checked')]
      .map((cb) => calls[Number(cb.value)])
      .filter(Boolean);
    if (!picked.length) { setFormStatus(status, 'error', 'Tick at least one job call to flag.'); return; }
    fd.append('subject', `Remove job call(s) — Local ${local.local_no} (${local.subtitle})`);
    fd.append('remove_calls', picked.map((c, i) => `${i + 1}. ${c.text}`).join('\n\n'));
    fd.append('notes', form.querySelector('[name=notes]').value.trim());
  } else {
    const call = form.querySelector('[name=call]').value.trim();
    if (!call) { setFormStatus(status, 'error', 'Paste the job call text first.'); return; }
    fd.append('subject', `Job call — Local ${local.local_no} (${local.subtitle})`);
    fd.append('job_call', call);
    fd.append('source', form.querySelector('[name=source]').value.trim());
  }

  submit.disabled = true;
  setFormStatus(status, '', 'Sending…');
  try {
    const endpoint = SUBMIT_URL || 'https://api.web3forms.com/submit';
    const res = await fetch(endpoint, { method: 'POST', body: fd });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.success) {
      setFormStatus(status, 'ok', 'Thanks — sent for review.');
      // lock the fields but leave "Back" usable
      form.querySelectorAll('input, textarea').forEach((el) => { el.disabled = true; });
    } else {
      setFormStatus(status, 'error', out.message || 'Submission failed — please try again later.');
      submit.disabled = false;
      resetCaptcha(form); // token is single-use
    }
  } catch {
    setFormStatus(status, 'error', 'Network error — please try again later.');
    submit.disabled = false;
    resetCaptcha(form);
  }
}

function buildJobsView(jc, { noBack = false } = {}) {
  const calls = jc.calls
    .map((c) => `<p class="detail__call">${esc(c.text)}</p>`)
    .join('');
  // the dataless local's inline jobs view (noBack) gets its buttons from the
  // trailing CONTRIB_BUTTONS instead, so skip the footer there
  const foot = [];
  if (!noBack) {
    foot.push('<button type="button" class="detail__link detail__back">←&nbsp;Wage data</button>');
    if (CAN_SUBMIT) {
      foot.push(
        '<span class="detail__footacts">' +
          (jc.calls.length
            ? '<button type="button" class="detail__go detail__go--delcall">Flag filled</button>'
            : '') +
          '<button type="button" class="detail__go detail__go--call">Add Job Call</button>' +
        '</span>',
      );
    }
  }
  return (
    `<div class="detail__jobs-head">${esc(jobCallLabel(jc.total))}` +
      (jc.posted ? ` <span class="detail__jobs-date">· ${esc(jc.posted)}</span>` : '') +
    '</div>' +
    (calls || '<p class="detail__call">No open calls listed right now.</p>') +
    (foot.length ? `<div class="detail__foot">${foot.join('')}</div>` : '')
  );
}

function renderList(points, meta) {
  if (loadError) {
    renderMessage(
      `Couldn't load the data.<br><span>${loadError}</span><br>` +
      `In local dev, run <code>./pb/pocketbase serve</code> then <code>node scripts/scrape.mjs</code>.`,
    );
    return;
  }
  // Roster-only locals (no value for this metric) aren't ranked; the only one
  // that can appear in the list is a selected one, shown pinned at the top.
  const valued = points.filter((p) => Number.isFinite(p.value));
  const dataless = points.filter((p) => !Number.isFinite(p.value));

  if (valued.length === 0 && !dataless.some((p) => p.id === state.selectedId)) {
    renderMessage(`No locals have a value for “${meta.label}”.`);
    return;
  }

  const sorted = [...valued].sort((a, b) =>
    state.sortDesc ? b.value - a.value : a.value - b.value
  );
  const rankById = new Map(sorted.map((p, i) => [p.id, i + 1]));

  // Pull the selected local to the top; everything else keeps its ranked order.
  let ordered = sorted;
  const selIdx = sorted.findIndex((p) => p.id === state.selectedId);
  if (selIdx > 0) {
    ordered = [sorted[selIdx], ...sorted.slice(0, selIdx), ...sorted.slice(selIdx + 1)];
  } else if (selIdx === -1) {
    const selDataless = dataless.find((p) => p.id === state.selectedId);
    if (selDataless) ordered = [selDataless, ...sorted];
  }

  // When ranking by job calls, the list value column still shows total package.
  const showTp = state.metricId === 'job_calls';

  els.list.innerHTML = '';
  ordered.forEach((p) => {
    const isSel = p.id === state.selectedId;
    const isDataless = !Number.isFinite(p.value);
    const li = document.createElement('li');
    li.className = 'city-list__item' + (isSel ? ' is-active' : '') +
      (isDataless ? ' city-list__item--nodata' : '');
    li.dataset.id = p.id;
    const n = jobCallCount(p.id);
    const valueText = isDataless
      ? (state.metricId === 'job_calls' ? 'no calls' : 'no data')
      : showTp
        ? (Number.isFinite(p.tp) && p.tp !== 0 ? metrics.total_package.format(p.tp) : '—')
        : meta.format(p.value);
    li.innerHTML =
      `<div class="city-list__row${n != null ? ' city-list__row--calls' : ''}">` +
        `<span class="city-list__rank">${rankById.get(p.id) ?? '·'}</span>` +
        '<span class="city-list__body">' +
          `<span class="city-list__name">${esc(p.name)}</span>` +
          `<span class="city-list__sub">${esc(p.subtitle)}</span>` +
        '</span>' +
        (n != null
          ? `<button type="button" class="city-list__calls">${esc(jobCallLabel(n))}</button>`
          : '') +
        `<span class="city-list__value">${esc(valueText)}</span>` +
      '</div>' +
      (isSel ? buildDetail(localById.get(p.id)) : '');
    li.querySelector('.city-list__row').addEventListener('click', () => onSelect(p.id));
    li.querySelector('.city-list__calls')?.addEventListener('click', (e) => {
      e.stopPropagation();
      onSelect(p.id, { view: 'jobs' });
    });
    if (isSel) {
      li.querySelector('.detail__close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        deselect();
      });
      const toView = (view) => (e) => {
        e.stopPropagation();
        // remember where a form was opened from, so its "Back" returns there
        if (view === 'edit' || view === 'addcall' || view === 'delcall') {
          state.detailReturn = state.detailView === 'jobs' ? 'jobs' : 'comp';
        }
        state.detailView = view;
        rerenderList();
      };
      li.querySelector('.detail__back')?.addEventListener('click', toView('comp'));
      li.querySelector('.detail__formcancel')?.addEventListener('click', toView(state.detailReturn || 'comp'));
      li.querySelector('.detail__go--edit')?.addEventListener('click', toView('edit'));
      li.querySelector('.detail__go--call')?.addEventListener('click', toView('addcall'));
      li.querySelector('.detail__go--delcall')?.addEventListener('click', toView('delcall'));
      const form = li.querySelector('.detail__form');
      if (form) {
        form.addEventListener('click', (e) => e.stopPropagation());
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          submitContribution(form, localById.get(p.id));
        });
      }
    }
    els.list.appendChild(li);
    if (isSel) renderCaptcha(li.querySelector('.detail__form')); // needs to be in the DOM
  });
}

function rerenderList() {
  renderList(pointsForMetric(state.metricId), metrics[state.metricId]);
}

function scrollActiveIntoView() {
  const active = els.list.querySelector('.city-list__item.is-active');
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Selection entry point. `fromMap` is true when the map's own select event
// drove this (so we don't call back into the map and loop). `view` picks which
// face of the green panel to open; when it isn't given we open 'jobs' only if
// the current metric IS "Open job calls" and this local has some, otherwise
// 'comp'. `selfDriven` marks the synchronous echo of our own map.select() call
// so it doesn't reset the view a list button just chose.
let selfDrivenSelect = false;

function onSelect(id, { fromMap = false, view } = {}) {
  const defaultView =
    state.metricId === 'job_calls' && jobCallCount(id) != null ? 'jobs' : 'comp';
  const nextView = view ?? (fromMap && selfDrivenSelect ? state.detailView : defaultView);
  const changed = state.selectedId !== id || state.detailView !== nextView;
  state.selectedId = id;
  state.detailView = nextView;
  if (!fromMap) {
    selfDrivenSelect = true;
    map.select(id);            // pan to + highlight the marker (fires 'select')
    selfDrivenSelect = false;
  }
  if (changed || !fromMap) rerenderList(); // reorder the list, expand the panel
  scrollActiveIntoView();
}

// Close the green detail panel: clear the selection and the map highlight.
function deselect() {
  if (!state.selectedId) return;
  state.selectedId = null;
  state.detailView = 'comp';
  map.select(null);
  rerenderList();
}

/* ---- redraw everything for the current metric ----------------------------- */

function update() {
  const meta = metrics[state.metricId];
  const points = pointsForMetric(state.metricId);
  const cmp = state.compare;

  syncRadii(); // grey-dot size depends on whether we're on the job-calls view
  map.setData(points, {
    valueLabel: cmp ? `${meta.label} vs cost of living` : meta.label,
    formatValue: meta.format,
  });
  map.renderLegend('#legend');

  const ranked = points.filter((p) => Number.isFinite(p.value)).length;
  els.panelTitle.textContent = loadError
    ? 'IBEW Locals'
    : `${meta.label}${cmp ? ' vs cost of living' : ''} · ${ranked} locals`;
  els.readout.textContent = loadError
    ? 'Data unavailable — see the list.'
    : cmp
      ? `${meta.label} ÷ local cost of living — higher means the pay goes further.`
      : `${meta.label} — ${meta.unit}. ${meta.hint}.`;
  els.sortLabel.textContent = state.sortDesc ? 'High → Low' : 'Low → High';

  renderList(points, meta);
}

/* ---- events --------------------------------------------------------------- */

els.select.addEventListener('change', () => {
  state.metricId = els.select.value;
  update();
});

// "Showing" ⇄ "Compare" — Compare divides the metric by local cost of living.
// Only the three pay totals make sense there, so the rest of the picker is
// locked out while it's on.
const COMPARE_METRICS = ['total_package', 'hourly_rate', 'yearly_salary'];

els.modeToggle.addEventListener('click', () => {
  state.compare = !state.compare;
  els.modeToggle.textContent = state.compare ? 'Compare' : 'Showing';
  els.modeToggle.setAttribute('aria-pressed', String(state.compare));
  els.modeNote.hidden = !state.compare;

  for (const opt of els.select.options) {
    opt.disabled = state.compare && !COMPARE_METRICS.includes(opt.value);
  }
  if (state.compare && !COMPARE_METRICS.includes(state.metricId)) {
    state.metricId = COMPARE_METRICS[0];
    els.select.value = state.metricId;
  }

  update();
});

els.sortToggle.addEventListener('click', () => {
  state.sortDesc = !state.sortDesc;
  update();
});

map.on('select', (city) => onSelect(city.id, { fromMap: true }));

/* ---- resizable sidebar (desktop only), width saved in a cookie ---------- */

const PANEL = { cookie: 'wl_panel_w', min: 240, max: 900, default: 480, days: 365 };
const isDesktop = () => window.matchMedia('(min-width: 821px)').matches;

const appBody = document.querySelector('.app__body');
const resizer = document.getElementById('panel-resizer');

function readCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function writeCookie(name, value) {
  const expires = new Date(Date.now() + PANEL.days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

const clampPanel = (px) =>
  Math.round(Math.max(PANEL.min, Math.min(px, Math.min(PANEL.max, window.innerWidth * 0.6))));

// `desiredWidth` is what the user picked; the applied width is that, re-clamped
// to whatever the viewport currently allows.
const savedWidth = parseInt(readCookie(PANEL.cookie), 10);
let desiredWidth = Number.isFinite(savedWidth) ? savedWidth : PANEL.default;

function applyPanelWidth(persist) {
  appBody.style.setProperty('--panel-w', clampPanel(desiredWidth) + 'px');
  if (persist) writeCookie(PANEL.cookie, desiredWidth);
}
function setPanelWidth(px, persist) {
  desiredWidth = clampPanel(px);
  applyPanelWidth(persist);
}

// restore saved width (harmless on mobile — the media query ignores --panel-w)
applyPanelWidth(false);

let dragging = false;
let rafId = 0;

resizer.addEventListener('pointerdown', (e) => {
  if (!isDesktop()) return;
  dragging = true;
  resizer.setPointerCapture(e.pointerId);
  resizer.classList.add('is-dragging');
  document.body.classList.add('is-resizing');
  e.preventDefault();
});

resizer.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const newWidth = e.clientX - appBody.getBoundingClientRect().left;
  setPanelWidth(newWidth, false);
  if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; map.resize(); });
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  resizer.classList.remove('is-dragging');
  document.body.classList.remove('is-resizing');
  try { resizer.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  writeCookie(PANEL.cookie, desiredWidth);
  map.resize();
}
resizer.addEventListener('pointerup', endDrag);
resizer.addEventListener('pointercancel', endDrag);

// double-click resets to the default width
resizer.addEventListener('dblclick', () => {
  if (!isDesktop()) return;
  setPanelWidth(PANEL.default, true);
  map.resize();
});

// keyboard: arrow keys nudge the divider
resizer.addEventListener('keydown', (e) => {
  if (!isDesktop()) return;
  const step = e.shiftKey ? 48 : 16;
  if (e.key === 'ArrowLeft') setPanelWidth(desiredWidth - step, true);
  else if (e.key === 'ArrowRight') setPanelWidth(desiredWidth + step, true);
  else return;
  e.preventDefault();
  map.resize();
});

window.addEventListener('resize', () => {
  applyPanelWidth(false); // re-clamp the user's chosen width to the new viewport
  map.resize();
});

/* ---- go ----------------------------------------------------------------- */

update();
// let the grid settle at the restored --panel-w, then size the map to it and
// frame the contiguous US (rather than fitToData, which zooms out for the
// handful of AK / HI / Canada locals).
requestAnimationFrame(() => {
  map.resize();
  map.leaflet.fitBounds(US_BOUNDS, { padding: [8, 8] });
});
