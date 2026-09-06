/**
 * main.js — glue between the data source (PocketBase, via dataSource.js), the
 * map module (cityMap.js) and the page chrome (metric picker, ranked list,
 * footer readout). Everything data-specific lives here; cityMap.js stays generic.
 */

import { metrics } from './metrics.js';
import { loadLocals } from './dataSource.js';
import { createCityMap } from './cityMap.js';

// Local, gitignored config (CARTO key + PocketBase URL).
let config = { cartoApiKey: '', pocketbaseUrl: 'http://127.0.0.1:8090' };
try {
  ({ config } = await import('./config.local.js'));
} catch {
  console.info('js/config.local.js not found — using defaults.');
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

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

const els = {
  select: document.getElementById('metric-select'),
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
};

const map = createCityMap('#map', {
  theme: prefersDark ? 'dark' : 'light',
  center: [43, -96], // North America — the map is pan-locked to this region
  zoom: 4,
  minZoom: 3,
  cartoApiKey: config.cartoApiKey || '',
});

/* ---- populate the metric <select> ------------------------------------- */

for (const [id, meta] of Object.entries(metrics)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = meta.label;
  els.select.appendChild(opt);
}
els.select.value = state.metricId;

/* ---- build the {id,name,subtitle,lat,lng,value} points for a metric --- */

function pointsForMetric(metricId) {
  return locals
    .filter((c) => Number.isFinite(c.values[metricId]))
    .map((c) => ({
      id: c.id,
      name: c.name,
      subtitle: c.subtitle,
      lat: c.lat,
      lng: c.lng,
      value: c.values[metricId],
    }));
}

/* ---- ranked locals list ------------------------------------------------- */

function renderMessage(text) {
  els.list.innerHTML = `<li class="city-list__empty">${text}</li>`;
}

function renderList(points, meta) {
  if (loadError) {
    renderMessage(
      `Couldn't load the data.<br><span>${loadError}</span><br>` +
      `Start it with <code>./pb/pocketbase serve</code>, then <code>node scripts/scrape.mjs</code>.`,
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

  els.list.innerHTML = '';
  sorted.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'city-list__item' + (p.id === state.selectedId ? ' is-active' : '');
    li.dataset.id = p.id;
    li.innerHTML = `
      <span class="city-list__rank">${i + 1}</span>
      <span class="city-list__body">
        <span class="city-list__name">${p.name}</span>
        <span class="city-list__sub">${p.subtitle}</span>
      </span>
      <span class="city-list__value">${meta.format(p.value)}</span>`;
    li.addEventListener('click', () => {
      map.select(p.id);
      setSelected(p.id);
    });
    els.list.appendChild(li);
  });
}

function setSelected(id) {
  state.selectedId = id;
  els.list.querySelectorAll('.city-list__item').forEach((li) => {
    li.classList.toggle('is-active', li.dataset.id === id);
  });
  const active = els.list.querySelector('.is-active');
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---- redraw everything for the current metric ----------------------------- */

function update() {
  const meta = metrics[state.metricId];
  const points = pointsForMetric(state.metricId);

  map.setData(points, {
    valueLabel: meta.label,
    formatValue: meta.format,
  });
  map.renderLegend('#legend');

  els.panelTitle.textContent = loadError ? 'IBEW Locals' : `${meta.label} · ${points.length} locals`;
  els.readout.textContent = loadError
    ? 'Data unavailable — see the list.'
    : `${meta.label} — ${meta.unit}. ${meta.hint}.`;
  els.sortLabel.textContent = state.sortDesc ? 'High → Low' : 'Low → High';

  renderList(points, meta);
}

/* ---- events --------------------------------------------------------------- */

els.select.addEventListener('change', () => {
  state.metricId = els.select.value;
  update();
});

els.sortToggle.addEventListener('click', () => {
  state.sortDesc = !state.sortDesc;
  update();
});

map.on('select', (city) => setSelected(city.id));

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
// let the grid settle at the restored --panel-w, then size the map to it
requestAnimationFrame(() => {
  map.resize();
  map.fitToData();
});
