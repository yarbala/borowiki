// Вся логика страницы. Данные приходят готовыми из data/spots.json, здесь только отрисовка.
//
// Задача: показать, где за последние 7 дней разряды молний пришлись на лес, и когда это было.
// Никаких прогнозов урожая — только измеренное. Когда ехать, решает человек;
// правило владельца («через 2–4 дня после грозы») отражено в цветах и подписях.

const STORE_KEY = 'borowiki.v1';
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const $ = (id) => document.getElementById(id);

/**
 * Свежесть грозы: чем недавнее разряд, тем краснее и крупнее метка.
 * Ступени в часах — «молния час назад» должна отличаться от «вчера».
 */
const AGE_RAMP = [
  [0, '#E5321F'],    // только что
  [12, '#F03E1C'],
  [36, '#F5821F'],   // вчера
  [84, '#F5C518'],   // 3–4 дня
  [168, '#B9B6AD'],  // неделя
];

function ageColor(hours) {
  const h = Math.max(0, Math.min(168, hours ?? 168));
  for (let i = 1; i < AGE_RAMP.length; i++) {
    const [h1, c1] = AGE_RAMP[i];
    if (h > h1) continue;
    const [h0, c0] = AGE_RAMP[i - 1];
    const t = (h - h0) / (h1 - h0);
    const rgb = (c) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
    const a = rgb(c0), b = rgb(c1);
    return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',')})`;
  }
  return AGE_RAMP[AGE_RAMP.length - 1][1];
}

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
  sheet: 'collapsed',
  selectedId: null,
  strikes: true,
  rain: false,
  settingsOpen: false,
  picking: false,
  home: saved.home || null,
  radius: saved.radius || 200,
  marks: saved.marks || {},
  located: null,
  allForests: null,
  stale: false,
  // Режим истории: дата снимка или null (живые данные).
  asOf: null,
  historyOpen: false,
  historyDates: [],
  historyBusy: null,
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

function distKm(home, lat, lon) {
  const R = 6371;
  const dLat = ((lat - home.lat) * Math.PI) / 180;
  const dLon = ((lon - home.lon) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((home.lat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Название уже может содержать деревню («Лес у Pokój») — тогда не повторяем её. */
const placePrefix = (sp) => (sp.place && !sp.forest.includes(sp.place) ? `у ${sp.place} · ` : '');

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

const BOLT_PATH = '7.5,1 2.4,6.9 5.7,6.9 4.5,11 9.6,5.1 6.3,5.1';

function boltSvg(size, color) {
  const s = svgEl('svg', { width: size, height: size, viewBox: '0 0 12 12' });
  s.append(svgEl('polygon', { points: BOLT_PATH, fill: color || 'currentColor' }));
  return s;
}

// ---------- карта ----------
//
// Векторные тайлы OpenFreeMap (данные OSM): лес есть отдельным слоем и виден
// на любом масштабе. Для обзора (z≤9) слой леса собран заранее в forests.json.

const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const CREDIT = '© OpenStreetMap';
const WOOD_COLOR = '#4E9A4E';
const WOOD_OPACITY = 0.5;

let map, mapReady = false, clickedFeature = false;

/** Та же шкала свежести, но выражением MapLibre. */
const ageColorExpr = () => ['interpolate', ['linear'], ['get', 'ago'], ...AGE_RAMP.flat()];

/** Иконка молнии: рисуем в canvas, чтобы не тянуть спрайты. */
function boltImage(size = 26) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const k = size / 12;
  BOLT_PATH.split(' ').forEach((pair, i) => {
    const [x, y] = pair.split(',').map(Number);
    if (i === 0) g.moveTo(x * k, y * k);
    else g.lineTo(x * k, y * k);
  });
  g.closePath();
  g.fillStyle = '#FFFFFF';
  g.fill();
  return { width: size, height: size, data: new Uint8Array(g.getImageData(0, 0, size, size).data) };
}

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

const forestsGeoJson = () =>
  fc((state.data.forests || []).filter((f) => f.agoDays != null).map((f) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [f.ring] },
    properties: { spotId: f.spotId, ago: f.agoHours ?? 168 },
  })));

const spotsGeoJson = () =>
  fc(state.data.spots.map((sp) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [sp.lon, sp.lat] },
    properties: { id: sp.id, ago: sp.agoHours },
  })));

/** Осадки: каждая ячейка сетки — квадрат, цвет по миллиметрам. */
function rainGeoJson() {
  const { stepDeg = 0.2, cells = [] } = state.data.rain || {};
  const h = stepDeg / 2;
  return fc(cells.map(([lat, lon, mm]) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[
      [lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h], [lon - h, lat - h],
    ]] },
    properties: { mm },
  })));
}

const strikesGeoJson = () =>
  fc((state.data.strikes || []).map(([lat, lon, ago]) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { ago },
  })));

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

    if (map.getLayer('landcover_wood')) {
      map.setPaintProperty('landcover_wood', 'fill-color', WOOD_COLOR);
      map.setPaintProperty('landcover_wood', 'fill-opacity', WOOD_OPACITY);
    }

    map.addImage('bolt', boltImage());

    // Свои слои — под подписями, чтобы названия городов оставались читаемыми.
    const labels = map.getStyle().layers.find((l) => l.type === 'symbol');
    const before = labels ? labels.id : undefined;

    if (state.allForests) {
      map.addSource('all-forests', { type: 'geojson', data: state.allForests });
      map.addLayer({
        id: 'all-forests',
        type: 'fill',
        source: 'all-forests',
        // Только для обзора: с z8 лес приходит из самих векторных тайлов, во всех подробностях.
        maxzoom: 9,
        // Без сглаживания краёв: контуры нарезаны по тайлам, и общие границы иначе проступают сеткой.
        paint: { 'fill-color': WOOD_COLOR, 'fill-opacity': WOOD_OPACITY, 'fill-antialias': false },
      }, before);
    }

    map.addSource('rain', { type: 'geojson', data: rainGeoJson() });
    map.addLayer({
      id: 'rain',
      type: 'fill',
      source: 'rain',
      layout: { visibility: state.rain ? 'visible' : 'none' },
      paint: {
        'fill-color': ['interpolate', ['linear'], ['get', 'mm'], 0, '#DCE9F7', 15, '#8FA9DA', 30, '#3E6FBF', 50, '#1B3E80'],
        'fill-opacity': 0.45,
        'fill-antialias': false,
      },
    }, before);

    map.addSource('strikes', { type: 'geojson', data: strikesGeoJson() });
    map.addLayer({
      id: 'strikes',
      type: 'circle',
      source: 'strikes',
      layout: { visibility: state.strikes ? 'visible' : 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 9, 3, 13, 6],
        'circle-color': ageColorExpr(),
        'circle-opacity': 0.55,
      },
    }, before);

    // Лес, по которому прошла гроза, — залит цветом давности.
    map.addSource('storm-forests', { type: 'geojson', data: forestsGeoJson() });
    map.addLayer({
      id: 'storm-forests',
      type: 'fill',
      source: 'storm-forests',
      paint: { 'fill-color': ageColorExpr(), 'fill-opacity': 0.75 },
    }, before);

    map.addSource('home', { type: 'geojson', data: homeGeoJson() });
    map.addSource('ring', { type: 'geojson', data: fc([circlePolygon(state.home.lat, state.home.lon, state.radius)]) });
    map.addLayer({
      id: 'ring',
      type: 'line',
      source: 'ring',
      paint: { 'line-color': '#161616', 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [4, 7] },
    }, before);

    // Сама метка грозы: кружок цвета давности и белая молния поверх.
    map.addSource('spots', { type: 'geojson', data: spotsGeoJson() });
    map.addLayer({
      id: 'spot-halo',
      type: 'circle',
      source: 'spots',
      paint: {
        // Свежая гроза — крупнее: её видно первой.
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          6, ['interpolate', ['linear'], ['get', 'ago'], 0, 9, 168, 6],
          9, ['interpolate', ['linear'], ['get', 'ago'], 0, 14, 168, 9],
          12, ['interpolate', ['linear'], ['get', 'ago'], 0, 19, 168, 12],
        ],
        'circle-color': ageColorExpr(),
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 2,
      },
    }, before);
    map.addLayer({
      id: 'spot-bolt',
      type: 'symbol',
      source: 'spots',
      layout: {
        'icon-image': 'bolt',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.45, 9, 0.7, 12, 0.95],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    }, before);

    map.addLayer({
      id: 'spot-selected',
      type: 'circle',
      source: 'spots',
      filter: ['==', ['get', 'id'], ''],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 11, 9, 15, 12, 19],
        'circle-color': 'rgba(0,0,0,0)',
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

    for (const layer of ['spot-halo', 'spot-bolt', 'storm-forests']) {
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

function highlightSelected() {
  if (!mapReady) return;
  map.setFilter('spot-selected', ['==', ['get', 'id'], state.selectedId || '']);
}

function drawSpots() {
  if (!mapReady) return;
  map.getSource('spots').setData(spotsGeoJson());
  map.getSource('storm-forests').setData(forestsGeoJson());
  map.getSource('strikes').setData(strikesGeoJson());
  map.getSource('rain').setData(rainGeoJson());
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
  map.fitBounds(bounds(sp.lat, sp.lon, (Math.max(sp.radiusM, 2000) / 1000) * 2.5), {
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
  $('homeLabel').value = state.home.label;
  persist();
  drawHome();
  render();
}

// ---------- отметки ----------

const current = () => (state.selectedId == null ? null : state.data.spots.find((s) => s.id === state.selectedId));

async function mark(kind) {
  const sp = current();
  if (!sp) return;
  const now = new Date();
  const entry = {
    kind,
    date: `${now.getDate()} ${MONTHS[now.getMonth()]}`,
    at: now.toISOString(),
    lat: sp.lat,
    lon: sp.lon,
    forest: sp.forest,
    // Чтобы потом проверить гипотезу: когда была гроза и на какой день вы приехали.
    stormUtc: sp.startUtc,
    daysAfterStorm: Math.round((now - new Date(sp.startUtc)) / 86400e3),
  };
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

// ---------- панели ----------

function visibleSpots() {
  return state.data.spots
    .map((sp) => ({ sp, dist: distKm(state.home, sp.lat, sp.lon) }))
    .filter((x) => x.dist <= state.radius + 0.5)
    .sort((a, b) => a.sp.agoHours - b.sp.agoHours || a.dist - b.dist);
}

function renderHandle(inRadius) {
  const storms = new Set(inRadius.map((x) => x.sp.stormId)).size;
  const freshest = inRadius.length ? inRadius[0].sp : null;

  $('topTitle').textContent = inRadius.length
    ? `Гроза над лесом: ${inRadius.length} ${plural(inRadius.length, ['место', 'места', 'мест'])}`
    : 'Гроза над лесом';

  $('topSub').textContent = freshest
    ? `${storms} ${plural(storms, ['гроза', 'грозы', 'гроз'])} за 7 дней · последняя ${freshest.agoText}`
    : `За 7 дней гроз над лесом в радиусе ${state.radius} км не было`;

  return inRadius.slice(0, 12);
}

function renderList(top) {
  const box = $('list');
  box.textContent = '';

  if (!top.length) {
    box.append(el('div', {
      className: 'empty-note',
      textContent: state.data.spots.length
        ? `В радиусе ${state.radius} км гроз над лесом не было — увеличьте радиус в настройках.`
        : 'За последние 7 дней гроз над лесами региона не было. Карта заполнится после ближайшей грозы.',
    }));
    return;
  }

  for (const x of top) {
    const color = ageColor(x.sp.agoHours);
    const b = el('button', { type: 'button', className: 'list-item' });
    b.append(
      el('span', { className: 'bolt' }, boltSvg(13, color)),
      el('span', { className: 'main' },
        el('span', { className: 'name', textContent: x.sp.forest }),
        // В строке мало места: показываем начало грозы и дождь, без конца интервала.
        el('span', { className: 'sub', textContent: `${x.sp.dayLabel}, ${x.sp.time.split('–')[0]} · ${x.sp.rainMm} мм дождя` })),
      el('span', { className: 'ago', style: `color:${color}` },
        el('b', { textContent: x.sp.agoText })),
      el('span', { className: 'dist', textContent: `${Math.round(x.dist)} км` }),
    );
    b.onclick = () => selectSpot(x.sp.id);
    box.append(b);
  }
}

function renderChart(sp) {
  const wrap = el('div', { className: 'chart-wrap' });
  const chart = el('div', { className: 'chart' });
  const bars = el('div', { className: 'chart-bars' });

  const { rain, storm, temp } = sp.chart;
  const maxR = Math.max(20, ...rain);

  rain.forEach((mm, i) => {
    const col = el('div');
    if (storm[i]) col.append(boltSvg(10, '#6B4EE6'));
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

  const start = new Date(sp.chart.startDate + 'T12:00:00');
  const mid = new Date(start);
  mid.setDate(mid.getDate() + Math.floor(n / 2));
  const axis = el('div', { className: 'chart-axis' },
    el('span', { textContent: `${start.getDate()} ${MONTHS_SHORT[start.getMonth()]}` }),
    el('span', { textContent: `${mid.getDate()} ${MONTHS_SHORT[mid.getMonth()]}` }),
    el('span', { textContent: 'сегодня' }));

  const legend = el('div', { className: 'chart-legend' },
    el('span', {}, el('i', { style: 'background:#8FA9DA' }), 'осадки, мм'),
    el('span', {}, el('i', { className: 'line' }), 'температура днём, °C'),
    el('span', {}, boltSvg(10, '#6B4EE6'), 'гроза'));

  wrap.append(chart, axis, legend);
  return wrap;
}

function renderCard() {
  const box = $('card');
  box.textContent = '';
  const sp = current();
  if (!sp) return;

  const color = ageColor(sp.agoHours);
  const dist = Math.round(distKm(state.home, sp.lat, sp.lon));
  const mk = state.marks[sp.id];

  const nav = el('div', { className: 'card-nav' });
  const back = el('button', { type: 'button', className: 'backbtn' }, el('i', {}), 'Все места');
  back.onclick = () => setSheet('list', null);
  const close = el('button', { type: 'button', className: 'close-btn', title: 'Закрыть', textContent: '×' });
  close.onclick = () => setSheet('collapsed', null);
  nav.append(back, close);

  const head = el('div', {},
    el('div', { className: 'card-title', textContent: sp.forest }),
    el('div', { className: 'card-place', textContent: `${placePrefix(sp)}${dist} км от дома` }),
    el('div', { className: 'card-coords', textContent: `${sp.lat.toFixed(4)} N, ${sp.lon.toFixed(4)} E · пятно ~${sp.radiusM >= 1000 ? (sp.radiusM / 1000).toFixed(1) + ' км' : sp.radiusM + ' м'}` }),
  );

  // Главное в карточке — когда была гроза и сколько дней прошло.
  const when = el('div', { className: 'when' },
    el('span', { className: 'when-bolt' }, boltSvg(22, color)),
    el('span', { className: 'when-text' },
      el('span', { className: 'when-date', textContent: `${sp.dayLabel}, ${sp.time}` }),
      el('span', { className: 'when-ago', style: `color:${color}`, textContent: sp.agoText })),
  );

  const fact = (k, v) => el('div', {}, el('span', { className: 'k', textContent: k }), el('span', { className: 'v', textContent: v }));
  const facts = el('div', { className: 'facts' },
    fact('Молнии', sp.strikesText),
    fact('Дождь в грозу', sp.rainText),
    fact('После грозы', sp.sinceRainText),
    fact('Температура', sp.tempText),
  );

  const actions = el('div', { className: 'actions' });
  actions.append(el('a', {
    className: 'route',
    href: `https://www.google.com/maps/dir/?api=1&destination=${sp.lat},${sp.lon}&travelmode=driving`,
    target: '_blank', rel: 'noopener', textContent: 'Маршрут к точке',
  }));
  const bFound = el('button', { type: 'button', className: 'mark', textContent: 'Нашёл грибы' });
  bFound.setAttribute('aria-pressed', String(mk?.kind === 'found'));
  bFound.onclick = () => mark('found');
  const bEmpty = el('button', { type: 'button', className: 'mark narrow', textContent: 'Пусто' });
  bEmpty.setAttribute('aria-pressed', String(mk?.kind === 'empty'));
  bEmpty.onclick = () => mark('empty');
  actions.append(bFound, bEmpty);

  box.append(nav, head, when, facts);

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
      el('span', { textContent: `Ваша отметка: ${mk.kind === 'found' ? 'нашёл грибы' : 'пусто'} · ${mk.date}${mk.daysAfterStorm != null ? ` · на ${mk.daysAfterStorm}-й день после грозы` : ''}` }));
    const un = el('button', { type: 'button', textContent: 'Убрать' });
    un.onclick = unmark;
    row.append(un);
    box.append(row);
  }
}

function renderStatus() {
  const d = state.data;
  const hours = (Date.now() - new Date(d.generatedAt).getTime()) / 3600e3;
  state.stale = !d.demo && hours > 3;
  const hhmm = new Date(d.dataThrough).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  if (state.asOf) {
    const label = new Date(state.asOf + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    $('statusText').textContent = `История: состояние на ${label}`;
    $('status').classList.remove('stale');
    $('credit').textContent = CREDIT;
    return;
  }

  $('statusText').textContent = d.demo
    ? `Демо-неделя ${d.demoLabel} · молнии MTG · леса OSM`
    : state.stale
      ? `Данные не обновлялись ${Math.round(hours)} ч · последний кадр ${hhmm}`
      : `Молнии MTG · леса OSM · данные по ${hhmm}`;
  $('status').classList.toggle('stale', state.stale);
  $('credit').textContent = CREDIT;
}

function render() {
  const inRadius = visibleSpots();
  const top = renderHandle(inRadius);

  $('list').hidden = state.sheet !== 'list';
  $('card').hidden = state.sheet !== 'card';
  $('sheetHandle').hidden = state.sheet === 'card';
  $('chev').classList.toggle('open', state.sheet === 'list');
  $('sheetHandle').setAttribute('aria-expanded', String(state.sheet === 'list'));

  if (state.sheet === 'list') renderList(top);
  if (state.sheet === 'card') renderCard();

  $('history').hidden = !state.historyOpen;
  $('historyBtn').setAttribute('aria-pressed', String(!!state.asOf));
  $('pickBar').hidden = !state.picking;
  $('legend').hidden = state.picking;
  $('settings').hidden = !state.settingsOpen;
  $('strikesBtn').setAttribute('aria-pressed', String(state.strikes));
  $('rainBtn').setAttribute('aria-pressed', String(state.rain));
  $('homeCoords').textContent = `${state.home.lat.toFixed(4)}, ${state.home.lon.toFixed(4)}`;
  $('radiusLabel').textContent = `${$('radius').value} км`;

  const d = state.data;
  const away = d?.home ? distKm(state.home, d.home.lat, d.home.lon) : 0;
  const far = away > (d.dataRadiusKm || 200);
  const note = $('regionNote');
  note.classList.toggle('warn', far);
  note.textContent = far
    ? `Дом в ${Math.round(away)} км от области данных. Молнии и леса собраны только вокруг ${d.home.label} (${d.dataRadiusKm || 200} км). Чтобы перенести область сюда, выполните на компьютере: npm run region -- "${state.home.label}"`
    : `Область данных: ${d.home.label} + ${d.dataRadiusKm || 200} км. Дом влияет на расстояния и список, но не расширяет её.`;

  highlightSelected();
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
  $('closeSettings').onclick = () => { state.settingsOpen = false; render(); };
  $('settings').onclick = (e) => { if (e.target === $('settings')) { state.settingsOpen = false; render(); } };
  $('saveSettings').onclick = () => {
    state.radius = +$('radius').value;
    state.home = { ...state.home, label: ($('homeLabel').value || '').trim() || 'Дом' };
    state.settingsOpen = false;
    persist();
    drawHome();
    fitHome();
    render();
  };
  $('radius').oninput = () => { $('radiusLabel').textContent = `${$('radius').value} км`; };

  const findPlace = async () => {
    const q = ($('homeLabel').value || '').trim();
    if (q.length < 2) return;
    const note = $('regionNote');
    note.textContent = 'Ищем…';
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=ru&q=${encodeURIComponent(q)}`;
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      const [hit] = await r.json();
      if (!hit) { note.textContent = `Не нашлось: ${q}`; return; }
      state.home = { lat: +(+hit.lat).toFixed(4), lon: +(+hit.lon).toFixed(4), label: hit.name || q };
      $('homeLabel').value = state.home.label;
      persist();
      drawHome();
      fitHome();
      render();
    } catch (e) {
      note.textContent = `Поиск не сработал: ${e.message}`;
    }
  };
  $('findHome').onclick = findPlace;
  $('homeLabel').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); findPlace(); } };

  $('startPick').onclick = () => {
    state.settingsOpen = false;
    state.picking = true;
    state.sheet = 'collapsed';
    state.selectedId = null;
    render();
  };
  $('cancelPick').onclick = () => { state.picking = false; state.settingsOpen = true; render(); };
  $('sheetHandle').onclick = () => setSheet(state.sheet === 'list' ? 'collapsed' : 'list', null);

  $('rainBtn').onclick = () => {
    state.rain = !state.rain;
    if (mapReady) map.setLayoutProperty('rain', 'visibility', state.rain ? 'visible' : 'none');
    render();
  };

  $('strikesBtn').onclick = () => {
    state.strikes = !state.strikes;
    if (mapReady) map.setLayoutProperty('strikes', 'visibility', state.strikes ? 'visible' : 'none');
    render();
  };

  $('historyBtn').onclick = () => {
    state.historyOpen = true;
    state.settingsOpen = false;
    $('historyNote').textContent = 'Молнии есть с 30 мая 2025. Дождь и температура — примерно за 75 последних дней.';
    refreshHistoryList();
    render();
  };
  $('closeHistory').onclick = () => { state.historyOpen = false; render(); };
  $('history').onclick = (e) => { if (e.target === $('history')) { state.historyOpen = false; render(); } };

  $('showHistory').onclick = async () => {
    const date = $('historyDate').value;
    if (!date) return;
    const note = $('historyNote');
    try {
      const r = await fetch('/api/history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date }),
      });
      const j = await r.json();
      if (j.error) { note.textContent = j.error; return; }
      if (j.ready) {
        await loadDataset(date);
        state.historyOpen = false;
        render();
        fitHome();
        return;
      }
      note.textContent = `Собираем ${date} — около 7 минут. Окно можно закрыть, снимок появится в списке.`;
      // Ждём готовности, не блокируя интерфейс.
      const poll = setInterval(async () => {
        await refreshHistoryList();
        if (state.historyDates.includes(date)) {
          clearInterval(poll);
          note.textContent = `Снимок на ${date} готов — выберите его в списке.`;
        }
      }, 15000);
    } catch (e) {
      note.textContent = `Не получилось: ${e.message}`;
    }
  };

  $('backToToday').onclick = async () => {
    try {
      await loadDataset(null);
      state.historyOpen = false;
      render();
      fitHome();
    } catch (e) {
      $('historyNote').textContent = e.message;
    }
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

const EMPTY = {
  generatedAt: new Date().toISOString(),
  dataThrough: new Date().toISOString(),
  demo: false,
  home: { lat: 51.1079, lon: 17.0385, label: 'Вроцлав' },
  dataRadiusKm: 200,
  spots: [],
  forests: [],
  strikes: [],
};

/** Загружает снимок: живой или на выбранную дату. */
async function loadDataset(date) {
  const url = date ? `./data/history/${date}.json` : './data/spots.json';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(date ? `снимок на ${date} не найден` : 'данные ещё не собраны');
  state.data = await res.json();
  state.asOf = date || null;
  state.selectedId = null;
  state.sheet = 'collapsed';
  state.stale = !state.asOf && !state.data.demo && (Date.now() - new Date(state.data.generatedAt).getTime()) / 3600e3 > 3;
  drawSpots();
  render();
}

async function refreshHistoryList() {
  try {
    const r = await fetch('/api/history', { cache: 'no-store' });
    const j = await r.json();
    state.historyDates = j.dates || [];
    state.historyBusy = j.building || null;
  } catch {}
  renderHistory();
}

function renderHistory() {
  const box = $('historyList');
  box.textContent = '';
  $('historyListBox').hidden = !state.historyDates.length;
  for (const d of state.historyDates) {
    const b = el('button', { type: 'button', textContent: new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) });
    b.setAttribute('aria-pressed', String(state.asOf === d));
    b.onclick = async () => {
      try {
        await loadDataset(d);
        state.historyOpen = false;
        render();
        fitHome();
      } catch (e) {
        $('historyNote').textContent = e.message;
      }
    };
    box.append(b);
  }
  if (state.historyBusy) {
    $('historyNote').textContent = `Собираем ${state.historyBusy} — это около 7 минут. Можно закрыть окно, снимок появится в списке.`;
  }
}

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
