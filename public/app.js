// Вся логика страницы. Данные приходят готовыми из data/spots.json, здесь только отрисовка.

const STORE_KEY = 'borowiki.v1';
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const $ = (id) => document.getElementById(id);

// ---------- состояние ----------

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

const saved = loadSaved();

const state = {
  data: null,
  horizon: 0,
  sheet: 'collapsed',
  selectedId: null,
  storms: false,
  settingsOpen: false,
  picking: false,
  home: saved.home || null,
  radius: saved.radius || 200,
  marks: saved.marks || {},
  located: null,
  allForests: null,
};

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ home: state.home, radius: state.radius, marks: state.marks }));
  } catch {}
}

// ---------- утилиты ----------

function plural(n, forms) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? forms[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? forms[1] : forms[2];
}

function rampColor(s) {
  if (s < 25) return '#B9B6AD';
  const Y = [245, 197, 24], O = [245, 130, 31], R = [229, 50, 31];
  const [a, b, t] = s <= 62 ? [Y, O, (s - 25) / 37] : [O, R, (s - 62) / 38];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const statusOf = (s) => (s >= 75 ? 'Пик' : s >= 50 ? 'Можно идти' : s >= 25 ? 'Скоро' : 'Нет условий');

function distKm(home, lat, lon) {
  const R = 6371;
  const dLat = ((lat - home.lat) * Math.PI) / 180;
  const dLon = ((lon - home.lon) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((home.lat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const hIndex = () => (state.horizon === 7 ? 2 : state.horizon === 3 ? 1 : 0);

/** Название уже может содержать деревню («Лес у Pokój») — тогда не повторяем её. */
const placePrefix = (sp) => (sp.place && !sp.forest.includes(sp.place) ? `у ${sp.place} · ` : '');

/** Точка отсчёта горизонта: сегодня, а в демо-режиме — конец демо-недели. */
const refDate = () => (state.data.demo ? new Date(state.data.dataThrough) : new Date());

function horizonLabel() {
  if (state.horizon === 0) return 'на сегодня';
  const d = refDate();
  d.setDate(d.getDate() + state.horizon);
  return `на ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null) n.append(k);
  return n;
};

const svgEl = (tag, attrs) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function boltSvg(size) {
  const s = svgEl('svg', { width: size, height: size, viewBox: '0 0 12 12' });
  s.append(svgEl('polygon', { points: '7.5,1 2.4,6.9 5.7,6.9 4.5,11 9.6,5.1 6.3,5.1', fill: 'currentColor' }));
  return s;
}

// ---------- карта ----------
//
// Векторные тайлы OpenFreeMap (данные OSM) вместо растровых: лес есть отдельным слоем
// `landcover` класса `wood`, поэтому все леса видны чётко на любом масштабе,
// а не только те, над которыми прошла гроза.

const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const CREDIT = '© OpenStreetMap';

/** Цвет леса на подложке — заметнее, чем в исходном стиле. */
const WOOD_COLOR = '#4E9A4E';
const WOOD_OPACITY = 0.5;

let map, mapReady = false, clickedFeature = false;

/** Выражение MapLibre: оценка выбранного горизонта → цвет шкалы. */
function colorExpr(prop) {
  return [
    'case',
    ['<', ['get', prop], 25], '#B9B6AD',
    ['interpolate', ['linear'], ['get', prop],
      25, '#F5C518',
      62, '#F5821F',
      100, '#E5321F'],
  ];
}

const scoreProp = () => `score${state.horizon}`;

/**
 * Размер точки: базовый радиус зависит от оценки, множитель — от масштаба.
 * `zoom` в MapLibre разрешён только на верхнем уровне interpolate, поэтому
 * масштабные ступени задаются как выражения от оценки, а не умножением сверху.
 */
function radiusExpr(prop, extra = 0) {
  const base = (k) => ['+', extra + 6 * k, ['*', 7 * k, ['/', ['max', 0, ['get', prop]], 100]]];
  return ['interpolate', ['linear'], ['zoom'], 6, base(0.35), 9, base(0.65), 11, base(1)];
}

/** Окружность радиуса km вокруг точки как полигон. */
function circlePolygon(lat, lon, km, points = 128) {
  const ring = [];
  const dLat = km / 110.574;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

const fc = (features) => ({ type: 'FeatureCollection', features });

function forestsGeoJson() {
  return fc(
    (state.data.forests || []).map((f) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [f.ring] },
      properties: { spotId: f.spotId, score0: f.scores?.[0] ?? -1, score3: f.scores?.[1] ?? -1, score7: f.scores?.[2] ?? -1 },
    })),
  );
}

function spotsGeoJson() {
  return fc(
    state.data.spots.map((sp) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [sp.lon, sp.lat] },
      properties: { id: sp.id, score0: sp.scores[0], score3: sp.scores[1], score7: sp.scores[2] },
    })),
  );
}

function strikesGeoJson() {
  return fc(
    (state.data.strikes || []).map(([lat, lon, ago]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { ago },
    })),
  );
}

function homeGeoJson() {
  const f = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [state.home.lon, state.home.lat] }, properties: { kind: 'home' } }];
  if (state.located) f.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [state.located[1], state.located[0]] }, properties: { kind: 'me' } });
  return fc(f);
}

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: STYLE,
    center: [state.home.lon, state.home.lat],
    zoom: 7,
    attributionControl: false,
    dragRotate: false,
  });
  map.touchZoomRotate.disableRotation();

  // Ссылка на карту в консоли — удобно проверять слои стиля вручную.
  window.__map = map;

  map.on('load', () => {
    mapReady = true;

    // Лес на подложке — заметный, чтобы было видно все массивы, а не только задетые грозой.
    if (map.getLayer('landcover_wood')) {
      map.setPaintProperty('landcover_wood', 'fill-color', WOOD_COLOR);
      map.setPaintProperty('landcover_wood', 'fill-opacity', WOOD_OPACITY);
      map.setPaintProperty('landcover_wood', 'fill-antialias', true);
    }

    // Свои слои — под подписями, чтобы названия городов оставались читаемыми.
    const labels = map.getStyle().layers.find((l) => l.type === 'symbol');
    const before = labels ? labels.id : undefined;

    // Все леса региона одним слоем: в тайлах лес появляется только с большого
    // приближения, а нужно видеть весь радиус сразу.
    if (state.allForests) {
      map.addSource('all-forests', { type: 'geojson', data: state.allForests });
      map.addLayer({
        id: 'all-forests',
        type: 'fill',
        source: 'all-forests',
        // Только для обзора: с z8 лес приходит из самих векторных тайлов, во всех подробностях.
        maxzoom: 9,
        // Без сглаживания краёв: контуры приходят нарезанными по тайлам, и общие
        // границы кусков иначе проступают сеткой.
        paint: { 'fill-color': WOOD_COLOR, 'fill-opacity': WOOD_OPACITY, 'fill-antialias': false },
      }, before);
    }

    map.addSource('strikes', { type: 'geojson', data: strikesGeoJson() });
    map.addLayer({
      id: 'strikes',
      type: 'circle',
      source: 'strikes',
      layout: { visibility: state.storms ? 'visible' : 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 9, 3, 13, 6],
        'circle-color': '#6B4EE6',
        'circle-opacity': ['max', 0.25, ['-', 0.75, ['/', ['get', 'ago'], 12]]],
      },
    }, before);

    map.addSource('storm-forests', { type: 'geojson', data: forestsGeoJson() });
    map.addLayer({
      id: 'storm-forests',
      type: 'fill',
      source: 'storm-forests',
      paint: { 'fill-color': colorExpr(scoreProp()), 'fill-opacity': 0.75, 'fill-antialias': true },
    }, before);

    map.addSource('home', { type: 'geojson', data: homeGeoJson() });
    map.addSource('ring', { type: 'geojson', data: fc([circlePolygon(state.home.lat, state.home.lon, state.radius)]) });
    map.addLayer({
      id: 'ring',
      type: 'line',
      source: 'ring',
      paint: { 'line-color': '#161616', 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [4, 7] },
    }, before);

    map.addSource('spots', { type: 'geojson', data: spotsGeoJson() });
    map.addLayer({
      id: 'spots',
      type: 'circle',
      source: 'spots',
      paint: {
        // На обзоре точек сотни: мелкие, чтобы не закрывать лес; при приближении крупнее.
        'circle-radius': radiusExpr(scoreProp()),
        'circle-color': colorExpr(scoreProp()),
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 10, 2],
      },
    }, before);

    map.addLayer({
      id: 'spot-selected',
      type: 'circle',
      source: 'spots',
      filter: ['==', ['get', 'id'], ''],
      paint: {
        'circle-radius': ['+', 8, ['*', 7, ['/', ['max', 0, ['get', scoreProp()]], 100]]],
        'circle-color': colorExpr(scoreProp()),
        'circle-stroke-color': '#1B1B18',
        'circle-stroke-width': 2.5,
      },
    }, before);

    map.addLayer({
      id: 'home',
      type: 'circle',
      source: 'home',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'kind'], 'me'], 7, 6],
        'circle-color': ['case', ['==', ['get', 'kind'], 'me'], '#2B5FB3', '#161616'],
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 2.5,
      },
    }, before);

    for (const layer of ['spots', 'storm-forests']) {
      map.on('click', layer, (e) => {
        if (state.picking) return;
        const f = e.features?.[0];
        const id = f?.properties?.id || f?.properties?.spotId;
        if (!id) return;
        clickedFeature = true;
        selectSpot(id);
      });
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    }

    map.on('click', (e) => {
      if (state.picking) { setHome(e.lngLat.lat, e.lngLat.lng); return; }
      if (clickedFeature) { clickedFeature = false; return; }
      if (state.sheet !== 'collapsed') setSheet('collapsed', null);
    });

    fitHome();
    render();
  });
}

/** Перекрашивание при смене горизонта: выражения ссылаются на другое поле. */
function restyle() {
  if (!mapReady) return;
  const prop = scoreProp();
  map.setPaintProperty('storm-forests', 'fill-color', colorExpr(prop));
  map.setPaintProperty('spots', 'circle-color', colorExpr(prop));
  map.setPaintProperty('spots', 'circle-radius', radiusExpr(prop));
  map.setPaintProperty('spot-selected', 'circle-color', colorExpr(prop));
  map.setPaintProperty('spot-selected', 'circle-radius', ['+', 8, ['*', 7, ['/', ['max', 0, ['get', prop]], 100]]]);
  map.setFilter('spot-selected', ['==', ['get', 'id'], state.selectedId || '']);
  const stale = state.stale ? 0.35 : 0.75;
  map.setPaintProperty('storm-forests', 'fill-opacity', stale);
}

function drawSpots() {
  if (!mapReady) return;
  map.getSource('spots').setData(spotsGeoJson());
  map.getSource('storm-forests').setData(forestsGeoJson());
  map.getSource('strikes').setData(strikesGeoJson());
}

function drawHome() {
  if (!mapReady) return;
  map.getSource('home').setData(homeGeoJson());
  map.getSource('ring').setData(fc([circlePolygon(state.home.lat, state.home.lon, state.radius)]));
}

function bounds(lat, lon, km) {
  const dLat = km / 110.574;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [[lon - dLon, lat - dLat], [lon + dLon, lat + dLat]];
}

function fitHome() {
  if (!mapReady) return;
  const h = window.innerHeight;
  map.fitBounds(bounds(state.home.lat, state.home.lon, state.radius), {
    padding: { top: Math.min(110, h * 0.18), bottom: Math.min(150, h * 0.25), left: 16, right: 16 },
    animate: false,
  });
}

function selectSpot(id) {
  state.selectedId = id;
  state.sheet = 'card';
  state.settingsOpen = false;
  render();
  const sp = state.data.spots.find((s) => s.id === id);
  if (!sp || !mapReady) return;
  const h = window.innerHeight;
  map.fitBounds(bounds(sp.lat, sp.lon, Math.max(sp.radiusM, 2000) / 1000 * 2.5), {
    padding: { top: Math.min(110, h * 0.15), bottom: Math.min(460, h * 0.58), left: 24, right: 24 },
    maxZoom: 13,
    duration: 800,
  });
}

function setSheet(sheet, selectedId = state.selectedId) {
  state.sheet = sheet;
  state.selectedId = selectedId;
  render();
}

function setHome(lat, lon) {
  state.home = { lat: +lat.toFixed(4), lon: +lon.toFixed(4), label: 'Точка на карте' };
  state.picking = false;
  state.settingsOpen = true;
  // Возвращаемся в настройки — поле с названием должно показывать новую точку.
  $('homeLabel').value = state.home.label;
  persist();
  drawHome();
  render();
}

// ---------- отметки ----------

async function mark(kind) {
  const sp = current();
  if (!sp) return;
  const now = new Date();
  const entry = { kind, date: `${now.getDate()} ${MONTHS[now.getMonth()]}`, at: now.toISOString(), lat: sp.lat, lon: sp.lon, forest: sp.forest };
  state.marks = { ...state.marks, [sp.id]: entry };
  persist();
  render();
  try {
    await fetch('/api/finds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: sp.id, ...entry }),
    });
  } catch {}
}

async function unmark() {
  const sp = current();
  if (!sp) return;
  const marks = { ...state.marks };
  delete marks[sp.id];
  state.marks = marks;
  persist();
  render();
  try {
    await fetch('/api/finds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sp.id, kind: null }) });
  } catch {}
}

const current = () => (state.selectedId == null ? null : state.data.spots.find((s) => s.id === state.selectedId));

// ---------- отрисовка панелей ----------

function visibleSpots() {
  return state.data.spots
    .map((sp) => ({ sp, dist: distKm(state.home, sp.lat, sp.lon), score: sp.scores[hIndex()] }))
    .filter((x) => x.dist <= state.radius + 0.5);
}

function renderHorizons() {
  const box = $('horizons');
  box.textContent = '';
  for (const [value, label] of [[0, 'Сегодня'], [3, '+3 дня'], [7, '+7 дней']]) {
    const b = el('button', { type: 'button', textContent: label });
    b.setAttribute('aria-pressed', String(state.horizon === value));
    b.onclick = () => {
      state.horizon = value;
      restyle();
      render();
    };
    box.append(b);
  }
}

function renderHandle(inRadius) {
  const top = inRadius.slice().sort((a, b) => b.score - a.score).slice(0, 5);
  const storms = new Set(inRadius.map((x) => x.sp.stormId ?? x.sp.startUtc)).size;
  $('topTitle').textContent = `Топ мест рядом (${top.length})`;
  $('topSub').textContent = inRadius.length
    ? `${horizonLabel()} · ${inRadius.length} ${plural(inRadius.length, ['пятно', 'пятна', 'пятен'])} после ${storms} ${plural(storms, ['грозы', 'гроз', 'гроз'])}`
    : `${horizonLabel()} · гроз над лесом не было`;
  return top;
}

function renderList(top) {
  const box = $('list');
  box.textContent = '';

  if (!top.length) {
    box.append(
      el('div', {
        className: 'empty-note',
        textContent: state.data.spots.length
          ? `В радиусе ${state.radius} км гроз над лесом не было — увеличьте радиус в настройках.`
          : `За последние 7 дней гроз над лесами региона не было. Карта заполнится после ближайшей грозы.`,
      }),
    );
    return;
  }

  top.forEach((x, i) => {
    const b = el('button', { type: 'button', className: 'list-item' });
    b.append(
      el('span', { className: 'rank', textContent: String(i + 1) }),
      el('span', { className: 'main' },
        el('span', { className: 'name', textContent: x.sp.forest }),
        el('span', { className: 'sub', textContent: `${placePrefix(x.sp)}${x.sp.dayLabel} · ${x.sp.time}` })),
      el('span', { className: 'score' },
        el('i', { style: `background:${rampColor(x.score)}` }),
        el('b', { textContent: String(x.score) })),
      el('span', { className: 'dist', textContent: `${Math.round(x.dist)} км` }),
    );
    b.onclick = () => selectSpot(x.sp.id);
    box.append(b);
  });
}

function renderChart(sp) {
  const wrap = el('div', { className: 'chart-wrap' });
  const chart = el('div', { className: 'chart' });
  const bars = el('div', { className: 'chart-bars' });

  const rain = sp.chart.rain, storm = sp.chart.storm, temp = sp.chart.temp;
  const maxR = Math.max(20, ...rain);

  rain.forEach((mm, i) => {
    const col = el('div');
    if (storm[i]) col.append(boltSvg(10));
    const h = mm > 0 ? Math.max(3, Math.round((mm / maxR) * 66)) : 1;
    const isToday = i === rain.length - 1;
    col.append(el('div', { className: 'bar', style: `height:${h}px;background:${isToday ? '#1B1B18' : mm > 0 ? '#8FA9DA' : '#ECEAE4'}` }));
    bars.append(col);
  });

  const n = temp.length;
  const pts = temp
    .map((t, i) => `${(((i + 0.5) / n) * 300).toFixed(1)},${(90 - ((Math.min(26, Math.max(4, t)) - 4) / 22) * 78).toFixed(1)}`)
    .join(' ');
  const line = svgEl('svg', { viewBox: '0 0 300 96', preserveAspectRatio: 'none', class: 'chart-line' });
  line.append(svgEl('polyline', {
    points: pts, fill: 'none', stroke: '#1B1B18', 'stroke-width': '1.6',
    'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke',
  }));

  chart.append(bars, line);

  const axis = el('div', { className: 'chart-axis' });
  const start = new Date(sp.chart.startDate + 'T12:00:00');
  const mid = new Date(start);
  mid.setDate(mid.getDate() + Math.floor(n / 2));
  const last = new Date(start);
  last.setDate(last.getDate() + n - 1);
  axis.append(
    el('span', { textContent: `${start.getDate()} ${MONTHS_SHORT[start.getMonth()]}` }),
    el('span', { textContent: `${mid.getDate()} ${MONTHS_SHORT[mid.getMonth()]}` }),
    // В демо-режиме «сегодня» — это конец демо-недели, поэтому пишем дату.
    el('span', { textContent: state.data.demo ? `${last.getDate()} ${MONTHS_SHORT[last.getMonth()]}` : 'сегодня' }),
  );

  const legend = el('div', { className: 'chart-legend' });
  legend.append(
    el('span', {}, el('i', { style: 'background:#8FA9DA' }), 'осадки, мм'),
    el('span', {}, el('i', { className: 'line' }), 'температура днём, °C'),
    el('span', {}, boltSvg(10), 'гроза'),
  );

  wrap.append(chart, axis, legend);
  return wrap;
}

function renderCard() {
  const box = $('card');
  box.textContent = '';
  const sp = current();
  if (!sp) return;

  const score = sp.scores[hIndex()];
  const color = rampColor(score);
  const dist = Math.round(distKm(state.home, sp.lat, sp.lon));
  const mk = state.marks[sp.id];

  const nav = el('div', { className: 'card-nav' });
  const back = el('button', { type: 'button', className: 'backbtn' }, el('i', {}), 'Топ мест');
  back.onclick = () => setSheet('list', null);
  const close = el('button', { type: 'button', className: 'close-btn', title: 'Закрыть', textContent: '×' });
  close.onclick = () => setSheet('collapsed', null);
  nav.append(back, close);

  const head = el('div', {},
    el('div', { className: 'card-title', textContent: sp.forest }),
    el('div', { className: 'card-place', textContent: `${placePrefix(sp)}${dist} км от дома` }),
    el('div', { className: 'card-coords', textContent: `${sp.lat.toFixed(4)} N, ${sp.lon.toFixed(4)} E · пятно ~${sp.radiusM >= 1000 ? (sp.radiusM / 1000).toFixed(1) + ' км' : sp.radiusM + ' м'}` }),
  );

  const scoreBlock = el('div', { className: 'score-block' },
    el('div', { className: 'score-row' },
      el('span', { className: 'big', textContent: String(score) }),
      el('span', { className: 'status', textContent: statusOf(score), style: `color:${color}` }),
      el('span', { className: 'horizon', textContent: `оценка ${horizonLabel()}` })),
    el('div', { className: 'score-bar' }, el('div', { style: `width:${score}%;background:${color}` })),
    el('div', { className: 'peak', textContent: sp.peak }),
  );

  const fact = (k, v, bolt) => {
    const value = el('span', { className: 'v' });
    if (bolt) value.append(boltSvg(12));
    value.append(v);
    return el('div', {}, el('span', { className: 'k', textContent: k }), value);
  };

  const facts = el('div', { className: 'facts' },
    fact('Гроза', `${sp.dayLabel}, ${sp.time}`, true),
    fact('Молнии', sp.strikesText),
    fact('Осадки', sp.rainText),
    fact('Температура', sp.tempText),
  );

  const actions = el('div', { className: 'actions' });
  actions.append(
    el('a', {
      className: 'route',
      href: `https://www.google.com/maps/dir/?api=1&destination=${sp.lat},${sp.lon}&travelmode=driving`,
      target: '_blank', rel: 'noopener', textContent: 'Маршрут к точке',
    }),
  );
  const bFound = el('button', { type: 'button', className: 'mark', textContent: 'Нашёл грибы' });
  bFound.setAttribute('aria-pressed', String(mk?.kind === 'found'));
  bFound.onclick = () => mark('found');
  const bEmpty = el('button', { type: 'button', className: 'mark narrow', textContent: 'Пусто' });
  bEmpty.setAttribute('aria-pressed', String(mk?.kind === 'empty'));
  bEmpty.onclick = () => mark('empty');
  actions.append(bFound, bEmpty);

  box.append(nav, head, scoreBlock, facts);

  // Сбор грибов в национальных парках и резерватах запрещён — предупреждаем до выезда.
  if (sp.protectedArea) {
    box.append(el('div', {
      className: sp.protectedArea.strict ? 'notice strict' : 'notice',
      textContent: sp.protectedArea.strict
        ? `${sp.protectedArea.name}: сбор грибов запрещён`
        : `${sp.protectedArea.name} — охраняемая территория, проверьте правила`,
    }));
  }

  box.append(renderChart(sp), actions);

  if (mk) {
    const row = el('div', { className: 'markrow' },
      el('span', { textContent: `Ваша отметка: ${mk.kind === 'found' ? 'нашёл грибы' : 'пусто'} · ${mk.date}` }));
    const un = el('button', { type: 'button', textContent: 'Убрать' });
    un.onclick = unmark;
    row.append(un);
    box.append(row);
  }
}

function renderStatus() {
  const d = state.data;
  const status = $('status');
  const hours = (Date.now() - new Date(d.generatedAt).getTime()) / 3600e3;
  state.stale = !d.demo && hours > 3;

  const hhmm = new Date(d.dataThrough).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('statusText').textContent = d.demo
    ? `Демо-неделя ${d.demoLabel} · молнии MTG · леса OSM`
    : state.stale
      ? `Данные не обновлялись ${Math.round(hours)} ч · последний кадр ${hhmm}`
      : `Молнии MTG · леса OSM · данные по ${hhmm}`;
  status.classList.toggle('stale', state.stale);
  $('credit').textContent = CREDIT;
}

function render() {
  const inRadius = visibleSpots();
  const top = renderHandle(inRadius);

  renderHorizons();
  $('list').hidden = state.sheet !== 'list';
  $('card').hidden = state.sheet !== 'card';
  $('sheetHandle').hidden = state.sheet === 'card';
  $('chev').classList.toggle('open', state.sheet === 'list');
  $('sheetHandle').setAttribute('aria-expanded', String(state.sheet === 'list'));

  if (state.sheet === 'list') renderList(top);
  if (state.sheet === 'card') renderCard();

  $('pickBar').hidden = !state.picking;
  $('legend').hidden = state.picking;
  $('settings').hidden = !state.settingsOpen;
  $('stormBtn').setAttribute('aria-pressed', String(state.storms));
  $('homeCoords').textContent = `${state.home.lat.toFixed(4)}, ${state.home.lon.toFixed(4)}`;
  $('radiusLabel').textContent = `${$('radius').value} км`;

  renderStatus();
}

// ---------- события ----------

function wire() {
  $('settingsBtn').onclick = () => {
    state.settingsOpen = true;
    state.picking = false;
    $('radius').value = state.radius;
    $('homeLabel').value = state.home.label;
    render();
  };
  $('closeSettings').onclick = () => {
    state.settingsOpen = false;
    render();
  };
  $('settings').onclick = (e) => {
    if (e.target === $('settings')) {
      state.settingsOpen = false;
      render();
    }
  };
  $('saveSettings').onclick = () => {
    state.radius = +$('radius').value;
    state.home = { ...state.home, label: ($('homeLabel').value || '').trim() || 'Дом' };
    state.settingsOpen = false;
    persist();
    drawHome();
    fitHome();
    render();
  };
  $('radius').oninput = () => {
    $('radiusLabel').textContent = `${$('radius').value} км`;
  };
  $('startPick').onclick = () => {
    state.settingsOpen = false;
    state.picking = true;
    state.sheet = 'collapsed';
    state.selectedId = null;
    render();
  };
  $('cancelPick').onclick = () => {
    state.picking = false;
    state.settingsOpen = true;
    render();
  };
  $('sheetHandle').onclick = () => setSheet(state.sheet === 'list' ? 'collapsed' : 'list', null);
  $('stormBtn').onclick = () => {
    state.storms = !state.storms;
    if (mapReady) map.setLayoutProperty('strikes', 'visibility', state.storms ? 'visible' : 'none');
    render();
  };
  $('locateBtn').onclick = () => {
    const fly = (lat, lon) => map.flyTo({ center: [lon, lat], zoom: 11, duration: 800 });
    const fallback = () => fly(state.home.lat, state.home.lon);
    if (!navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition(
      (p) => {
        state.located = [p.coords.latitude, p.coords.longitude];
        drawHome();
        fly(p.coords.latitude, p.coords.longitude);
      },
      fallback,
      { timeout: 5000, maximumAge: 60000 },
    );
  };
}

// ---------- запуск ----------

/** Пустые данные: карта должна работать, даже если сборка ещё не отработала. */
const EMPTY = {
  generatedAt: new Date().toISOString(),
  dataThrough: new Date().toISOString(),
  demo: false,
  home: { lat: 51.1079, lon: 17.0385, label: 'Вроцлав' },
  spots: [],
  strikes: [],
};

async function boot() {
  let problem = null;
  try {
    const res = await fetch('./data/spots.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? 'данные ещё не собраны' : `HTTP ${res.status}`);
    state.data = await res.json();
  } catch (e) {
    state.data = EMPTY;
    problem = e.message;
  }

  if (!state.home) state.home = { ...state.data.home };
  // Считаем до первой отрисовки: от этого зависит прозрачность пятен на карте.
  state.stale = !state.data.demo && (Date.now() - new Date(state.data.generatedAt).getTime()) / 3600e3 > 3;

  try {
    const res = await fetch('./data/forests.json', { cache: 'force-cache' });
    if (res.ok) state.allForests = await res.json();
  } catch {}

  try {
    const finds = await fetch('/api/finds').then((r) => (r.ok ? r.json() : null));
    if (finds && typeof finds === 'object') state.marks = { ...finds, ...state.marks };
  } catch {}

  $('radius').value = state.radius;
  $('homeLabel').value = state.home.label;

  initMap();
  wire();
  render();

  if (problem) {
    $('statusText').textContent = `Нет данных: ${problem}. Запустите npm run update`;
    $('status').classList.add('stale');
  }
}

boot();
