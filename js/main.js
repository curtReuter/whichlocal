/**
 * main.js — glue between the data source (PocketBase, via dataSource.js), the
 * map module (cityMap.js) and the page chrome (metric picker, ranked list,
 * footer readout). Everything data-specific lives here; cityMap.js stays generic.
 */

// ?v= must match index.html — bump both together on any frontend change so
// browsers don't serve a stale module past GitHub Pages' 10-minute cache.
import { metrics } from './metrics.js?v=14';
import { loadLocals } from './dataSource.js?v=14';
import { createCityMap } from './cityMap.js?v=14';

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

// id → full local (all metric values, wage-sheet URL, source date) for the
// expanding detail panel.
const localById = new Map(locals.map((c) => [c.id, c]));

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

const els = {
  select: document.getElementById('metric-select'),
  modeOpts: document.querySelectorAll('.mode-switch__opt'),
  modeNote: document.getElementById('mode-note'),
  list: document.getElementById('city-list'),
  panelTitle: document.getElementById('panel-title'),
  sortToggle: document.getElementById('sort-toggle'),
  sortLabel: document.getElementById('sort-label'),
  readout: document.getElementById('readout'),
};

const state = {
  metricId: 'total_package',
  sortDesc: true,
  selectedId: null,
  // "Compare" mode: show a unitless profitability score instead of the raw
  // metric — the metric adjusted for local cost of living (see compareScore).
  compare: false,
};

// Contiguous US — the first-load view. Panning to AK / HI / Canada still works
// (the map's maxBounds is the wider North-America box).
const US_BOUNDS = [[25.5, -123.5], [48.5, -67]];

const map = createCityMap('#map', {
  theme: prefersDark ? 'dark' : 'light',
  center: [39.5, -98], // continental US; refined to US_BOUNDS on load
  zoom: 4,
  minZoom: 3,
  cartoApiKey: config.cartoApiKey || '',
});

// On phones, tuck the map attribution into the bottom-left corner and drop the
// "Leaflet" prefix so it's a tiny unobtrusive line (CSS shrinks the type).
const L = window.L;
const DEFAULT_ATTR_PREFIX = L.Control.Attribution.prototype.options.prefix;
const mqMobile = window.matchMedia('(max-width: 820px)');
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
els.select.value = state.metricId;

/* ---- build the {id,name,subtitle,lat,lng,value} points for a metric --- */

// Compare mode turns the metric into a unitless "profitability score":
//   score = value ÷ (cost of living ÷ 100) − 50
const compareScore = (value, colPct) => value / (colPct / 100) - 50;

// How a value column / tooltip / legend entry is formatted right now.
const fmtScore = (v) => v.toFixed(1);
const valueFormat = () => (state.compare ? fmtScore : metrics[state.metricId].format);

function pointsForMetric(metricId) {
  return locals
    .map((c) => {
      let value = c.values[metricId];
      if (!Number.isFinite(value)) return null;
      if (state.compare) {
        const col = c.values.col_pct;
        if (!Number.isFinite(col) || col <= 0) return null;
        value = compareScore(value, col);
      }
      return { id: c.id, name: c.name, subtitle: c.subtitle, lat: c.lat, lng: c.lng, value };
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

// The green panel that expands under the selected local: every metric it has a
// value for, plus the source date and wage-sheet link.
function buildDetail(local) {
  if (!local) return '';

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
  if (local.sourceUpdated) foot.push(`<span>Source updated ${esc(local.sourceUpdated)}</span>`);
  if (local.wageSheetUrl) {
    foot.push(
      `<a href="${esc(local.wageSheetUrl)}" target="_blank" rel="noopener">Wage sheet&nbsp;↗</a>`,
    );
  }

  return (
    '<div class="city-list__detail"><div class="detail__inner">' +
      '<button type="button" class="detail__close" aria-label="Close details">×</button>' +
      `<div class="detail__grid">${cells.join('')}</div>` +
      (foot.length ? `<div class="detail__foot">${foot.join('')}</div>` : '') +
    '</div></div>'
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
  if (points.length === 0) {
    renderMessage(`No locals have a value for “${meta.label}”.`);
    return;
  }

  const sorted = [...points].sort((a, b) =>
    state.sortDesc ? b.value - a.value : a.value - b.value
  );
  const rankById = new Map(sorted.map((p, i) => [p.id, i + 1]));

  // Pull the selected local to the top; everything else keeps its ranked order.
  let ordered = sorted;
  const selIdx = sorted.findIndex((p) => p.id === state.selectedId);
  if (selIdx > 0) {
    ordered = [sorted[selIdx], ...sorted.slice(0, selIdx), ...sorted.slice(selIdx + 1)];
  }

  els.list.innerHTML = '';
  ordered.forEach((p) => {
    const isSel = p.id === state.selectedId;
    const li = document.createElement('li');
    li.className = 'city-list__item' + (isSel ? ' is-active' : '');
    li.dataset.id = p.id;
    li.innerHTML =
      '<div class="city-list__row">' +
        `<span class="city-list__rank">${rankById.get(p.id)}</span>` +
        '<span class="city-list__body">' +
          `<span class="city-list__name">${esc(p.name)}</span>` +
          `<span class="city-list__sub">${esc(p.subtitle)}</span>` +
        '</span>' +
        `<span class="city-list__value">${esc(valueFormat()(p.value))}</span>` +
      '</div>' +
      (isSel ? buildDetail(localById.get(p.id)) : '');
    li.querySelector('.city-list__row').addEventListener('click', () => onSelect(p.id));
    if (isSel) {
      li.querySelector('.detail__close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        deselect();
      });
    }
    els.list.appendChild(li);
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
// drove this (so we don't call back into the map and loop).
function onSelect(id, { fromMap = false } = {}) {
  const changed = state.selectedId !== id;
  state.selectedId = id;
  if (!fromMap) map.select(id);            // pan to + highlight the marker
  if (changed || !fromMap) rerenderList(); // reorder the list, expand the panel
  scrollActiveIntoView();
}

// Close the green detail panel: clear the selection and the map highlight.
function deselect() {
  if (!state.selectedId) return;
  state.selectedId = null;
  map.select(null);
  rerenderList();
}

/* ---- redraw everything for the current metric ----------------------------- */

function update() {
  const meta = metrics[state.metricId];
  const points = pointsForMetric(state.metricId);
  const cmp = state.compare;

  map.setData(points, {
    valueLabel: cmp ? `${meta.label} profitability score` : meta.label,
    formatValue: valueFormat(),
  });
  map.renderLegend('#legend');

  els.panelTitle.textContent = loadError
    ? 'IBEW Locals'
    : `${meta.label}${cmp ? ' profitability score' : ''} · ${points.length} locals`;
  els.readout.textContent = loadError
    ? 'Data unavailable — see the list.'
    : cmp
      ? `Profitability score — ${meta.label} ÷ local cost of living, minus 50. Higher means the pay goes further.`
      : `${meta.label} — ${meta.unit}. ${meta.hint}.`;
  els.sortLabel.textContent = state.sortDesc ? 'High → Low' : 'Low → High';

  renderList(points, meta);
}

/* ---- events --------------------------------------------------------------- */

els.select.addEventListener('change', () => {
  state.metricId = els.select.value;
  update();
});

// "Showing" ⇄ "Compare" segmented switch. Compare divides the metric by local
// cost of living, so the two percentage metrics (which aren't dollars) can't
// be compared against it.
const COMPARE_EXCLUDED = ['col_pct', 'dues'];

function setCompare(on) {
  state.compare = on;
  els.modeOpts.forEach((b) => {
    const active = (b.dataset.mode === 'compare') === on;
    b.classList.toggle('is-on', active);
    b.setAttribute('aria-pressed', String(active));
  });
  els.modeNote.hidden = !on;

  for (const id of COMPARE_EXCLUDED) {
    const opt = els.select.querySelector(`option[value="${id}"]`);
    if (opt) opt.disabled = on;
  }
  if (on && COMPARE_EXCLUDED.includes(state.metricId)) {
    state.metricId = 'total_package';
    els.select.value = state.metricId;
  }

  update();
}

els.modeOpts.forEach((b) =>
  b.addEventListener('click', () => setCompare(b.dataset.mode === 'compare')),
);

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
