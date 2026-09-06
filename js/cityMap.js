/**
 * cityMap.js — a small, framework-free module that renders a slippy map with
 * one circular "hotspot" per city. Each circle's radius and fill colour are
 * derived from a single numeric data value, so swapping the value re-scales
 * and re-colours the whole map.
 *
 * Depends on Leaflet being available as the global `L` (loaded via <script> in
 * index.html). Pass your own instance with `options.L` if you bundle it.
 *
 *   import { createCityMap } from './cityMap.js';
 *
 *   const map = createCityMap('#map', { theme: 'light' });
 *   map.setData(
 *     [{ id: 'nyc', name: 'New York', subtitle: 'USA', lat: 40.7, lng: -74, value: 8.5 }],
 *     { valueLabel: 'Population', formatValue: v => v + 'M' }
 *   );
 *   map.on('select', city => console.log(city.name));
 *   map.renderLegend('#legend');
 */

const DEFAULT_OPTIONS = {
  L: (typeof window !== 'undefined' ? window.L : undefined),
  center: [43, -96],   // continental North America
  zoom: 4,
  minZoom: 3,
  maxZoom: 12,
  maxBounds: [[5, -170], [75, -45]], // pan-lock box: North America only (null = no lock)
  maxBoundsViscosity: 1.0,           // 1 = hard wall at the bounds
  minRadius: 8,     // px — radius of the smallest value
  maxRadius: 40,    // px — radius of the largest value
  theme: 'light',   // 'light' | 'dark' — only picks the basemap tiles
  cartoApiKey: '',  // CARTO raster basemap key; substituted for {key} in the tile URL
  tileUrl: '',      // override the basemap URL entirely (may contain {key})
  // A sequential colour ramp, low value → high value. Override for your brand.
  colorRamp: ['#2c7bb6', '#00a6ca', '#4dd0a7', '#a6d96a', '#ffffbf', '#fdae61', '#f46d43', '#d7191c'],
};

// CARTO raster (PNG) basemaps. A valid ?key= authenticates the request and
// removes the "add your API key" watermark CARTO bakes into unkeyed tiles.
const TILES = {
  // Positron ("light_all") — near-grey water, no teal. Swap to rastertiles/voyager
  // for the coloured land/water Voyager style.
  light: {
    url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key={key}',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  },
  dark: {
    url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key={key}',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  },
};

/** Fill the {key} placeholder, or drop the whole key param when we have none. */
function buildTileUrl(template, key) {
  if (key) return template.replace('{key}', encodeURIComponent(key));
  return template.replace(/[?&]key=\{key\}/, '').replace('{key}', '');
}

/* ---------- colour + scale helpers ------------------------------------- */

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToCss([r, g, b]) {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/** Sample a multi-stop ramp at t ∈ [0,1] with linear RGB interpolation. */
function sampleRamp(ramp, t) {
  const stops = ramp.map(hexToRgb);
  const x = clamp01(t) * (stops.length - 1);
  const i = Math.floor(x);
  const frac = x - i;
  if (i >= stops.length - 1) return rgbToCss(stops[stops.length - 1]);
  const a = stops[i];
  const b = stops[i + 1];
  return rgbToCss([
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
    a[2] + (b[2] - a[2]) * frac,
  ]);
}

/**
 * Radius in px for a value, using a square-root scale so that circle *area*
 * (what the eye reads) grows roughly in proportion to the value.
 */
function radiusFor(value, min, max, minR, maxR) {
  if (max <= min) return (minR + maxR) / 2;
  const t = clamp01((value - min) / (max - min));
  return minR + (maxR - minR) * Math.sqrt(t);
}

/* ---------- the module ----------------------------------------------------- */

export function createCityMap(target, userOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...userOptions };
  const L = opts.L;
  if (!L) throw new Error('cityMap: Leaflet (L) not found. Load it before this module or pass options.L.');

  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) throw new Error(`cityMap: container "${target}" not found.`);

  const map = L.map(el, {
    center: opts.center,
    zoom: opts.zoom,
    minZoom: opts.minZoom,
    maxZoom: opts.maxZoom,
    maxBounds: opts.maxBounds ? L.latLngBounds(opts.maxBounds) : undefined,
    maxBoundsViscosity: opts.maxBoundsViscosity,
    zoomControl: true,
  });

  const tiles = TILES[opts.theme] || TILES.light;
  const tileUrl = buildTileUrl(opts.tileUrl || tiles.url, opts.cartoApiKey);
  L.tileLayer(tileUrl, { attribution: tiles.attribution, noWrap: true }).addTo(map);

  // Keep the map filling its box on ANY layout change (sidebar drag, window
  // resize, late font load) so the container background never shows as a strip.
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    let roFrame = 0;
    ro = new ResizeObserver(() => {
      if (roFrame) return;
      roFrame = requestAnimationFrame(() => { roFrame = 0; map.invalidateSize({ pan: false }); });
    });
    ro.observe(el);
  }

  const layer = L.layerGroup().addTo(map);
  const listeners = { select: [] };
  const markersById = new Map();

  let current = {
    points: [],
    min: 0,
    max: 1,
    meta: { valueLabel: 'Value', formatValue: (v) => String(v), lowerIsBetter: false },
  };
  let selectedId = null;

  function emit(name, payload) {
    (listeners[name] || []).forEach((fn) => fn(payload));
  }

  function styleFor(value, isSelected) {
    const { min, max } = current;
    const t = max > min ? (value - min) / (max - min) : 0.5;
    return {
      radius: radiusFor(value, min, max, opts.minRadius, opts.maxRadius),
      color: isSelected ? '#111827' : '#ffffff',
      weight: isSelected ? 3 : 1.5,
      opacity: 1,
      fillColor: sampleRamp(opts.colorRamp, t),
      fillOpacity: 0.82,
    };
  }

  function draw() {
    layer.clearLayers();
    markersById.clear();

    current.points.forEach((p) => {
      const marker = L.circleMarker([p.lat, p.lng], {
        ...styleFor(p.value, p.id === selectedId),
        className: 'city-hotspot',
        bubblingMouseEvents: false,
      });

      const valueText = current.meta.formatValue(p.value);
      marker.bindTooltip(
        `<strong>${escapeHtml(p.name)}</strong>` +
          (p.subtitle ? `<span class="tt-sub">${escapeHtml(p.subtitle)}</span>` : '') +
          `<span class="tt-val">${escapeHtml(current.meta.valueLabel)}: <b>${escapeHtml(valueText)}</b></span>`,
        { direction: 'top', offset: [0, -4], className: 'city-tooltip', sticky: false }
      );

      marker.on('mouseover', () => marker.setStyle({ weight: 3 }));
      marker.on('mouseout', () =>
        marker.setStyle({ weight: p.id === selectedId ? 3 : 1.5 })
      );
      marker.on('click', () => select(p.id, { pan: false }));

      marker.addTo(layer);
      markersById.set(p.id, marker);
    });
  }

  /* ---- public API ------------------------------------------------------ */

  function setData(points, meta = {}) {
    const clean = (points || []).filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.value)
    );
    const values = clean.map((p) => p.value);
    current = {
      points: clean,
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 1,
      meta: { ...current.meta, ...meta },
    };
    if (selectedId && !clean.some((p) => p.id === selectedId)) selectedId = null;
    draw();
    return api;
  }

  function fitToData(padding = [40, 40]) {
    if (!current.points.length) return api;
    const bounds = L.latLngBounds(current.points.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding });
    return api;
  }

  function select(id, { pan = true } = {}) {
    const point = current.points.find((p) => p.id === id);
    selectedId = point ? id : null;

    markersById.forEach((marker, markerId) => {
      const p = current.points.find((c) => c.id === markerId);
      if (p) marker.setStyle(styleFor(p.value, markerId === selectedId));
    });

    if (point) {
      const marker = markersById.get(id);
      if (marker) {
        marker.bringToFront();
        marker.openTooltip();
      }
      if (pan) map.flyTo([point.lat, point.lng], Math.max(map.getZoom(), 4), { duration: 0.6 });
      emit('select', point);
    }
    return api;
  }

  function on(name, handler) {
    if (!listeners[name]) listeners[name] = [];
    listeners[name].push(handler);
    return api;
  }

  function resize() {
    map.invalidateSize();
    return api;
  }

  /** Render a colour-gradient + circle-size legend into `legendTarget`. */
  function renderLegend(legendTarget) {
    const box = typeof legendTarget === 'string' ? document.querySelector(legendTarget) : legendTarget;
    if (!box) return api;

    const { min, max, meta } = current;
    const gradient = opts.colorRamp.join(', ');

    box.innerHTML = `
      <div class="legend__title">${escapeHtml(meta.valueLabel)}</div>
      <div class="legend__bar" style="background: linear-gradient(90deg, ${gradient});"></div>
      <div class="legend__scale">
        <span>${escapeHtml(meta.formatValue(min))}</span>
        <span>${escapeHtml(meta.formatValue(max))}</span>
      </div>`;
    box.setAttribute('aria-hidden', 'false');
    return api;
  }

  function destroy() {
    if (ro) ro.disconnect();
    map.remove();
    listeners.select = [];
    markersById.clear();
  }

  const api = { setData, fitToData, select, on, resize, renderLegend, destroy, get leaflet() { return map; } };
  return api;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
