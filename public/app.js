// Вся логика страницы. Данные приходят готовыми из data/spots.json, здесь только отрисовка.

const STORE_KEY = 'borowiki.v1';
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const TILES = {
  url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png',
  opts: { maxZoom: 18 },
  credit: '© OpenStreetMap',
};

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
  radius: saved.radius || 100,
  marks: saved.marks || {},
  located: null,
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

function horizonLabel() {
  if (state.horizon === 0) return 'на сегодня';
  const d = new Date();
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

let map, footLayer, pinLayer, strikeLayer, homeLayer, outlineLayer;
const foots = {}, pins = {};

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: false });
  L.tileLayer(TILES.url, TILES.opts).addTo(map);
  map.createPane('spots').style.zIndex = 410;

  outlineLayer = L.layerGroup().addTo(map);
  footLayer = L.layerGroup().addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  homeLayer = L.layerGroup().addTo(map);

  map.on('click', () => {
    if (state.picking) return;
    if (state.sheet !== 'collapsed') setSheet('collapsed', null);
  });
  map.on('click', (e) => {
    if (state.picking) setHome(e.latlng.lat, e.latlng.lng);
  });
}

function spotStyle(sp) {
  const s = sp.scores[hIndex()];
  const sel = state.selectedId === sp.id;
  const stale = !!state.stale;
  const c = rampColor(s);
  return {
    foot: { stroke: true, color: c, weight: sel ? 1.5 : 1, opacity: stale ? 0.3 : 0.7, fill: true, fillColor: c, fillOpacity: stale ? 0.08 : 0.2 },
    pin: {
      radius: (s < 25 ? 6 : 6 + (s / 100) * 7) + (sel ? 2 : 0),
      stroke: true,
      color: sel ? '#1B1B18' : '#FFFFFF',
      weight: sel ? 2.5 : 2,
      opacity: 1,
      fill: true,
      fillColor: c,
      fillOpacity: stale ? 0.5 : 1,
    },
  };
}

function drawSpots() {
  footLayer.clearLayers();
  pinLayer.clearLayers();
  outlineLayer.clearLayers();
  for (const k of Object.keys(foots)) delete foots[k];
  for (const k of Object.keys(pins)) delete pins[k];

  for (const sp of state.data.spots) {
    const st = spotStyle(sp);
    const onClick = (e) => {
      L.DomEvent.stopPropagation(e);
      if (state.picking) setHome(e.latlng.lat, e.latlng.lng);
      else selectSpot(sp.id);
    };

    if (sp.outline?.length) {
      L.polygon(sp.outline.map(([lon, lat]) => [lat, lon]), {
        pane: 'spots', interactive: false, stroke: true, color: '#2E6B2E', weight: 1, opacity: 0.35, fill: false,
      }).addTo(outlineLayer);
    }

    foots[sp.id] = L.circle([sp.lat, sp.lon], { radius: sp.radiusM, pane: 'spots', bubblingMouseEvents: false, ...st.foot })
      .on('click', onClick)
      .addTo(footLayer);
    pins[sp.id] = L.circleMarker([sp.lat, sp.lon], { pane: 'spots', bubblingMouseEvents: false, ...st.pin })
      .on('click', onClick)
      .addTo(pinLayer);
  }

  const strikes = state.data.strikes || [];
  const canvas = L.canvas({ padding: 0.5 });
  strikeLayer = L.layerGroup(
    strikes.map(([lat, lon, ago]) =>
      L.circleMarker([lat, lon], {
        renderer: canvas,
        radius: 2.6,
        stroke: false,
        fillColor: '#6B4EE6',
        fillOpacity: Math.max(0.3, 1 - ago / 8),
        interactive: false,
      }),
    ),
  );
  if (state.storms) strikeLayer.addTo(map);
}

function restyle() {
  for (const sp of state.data.spots) {
    const st = spotStyle(sp);
    foots[sp.id]?.setStyle(st.foot);
    if (pins[sp.id]) {
      pins[sp.id].setStyle(st.pin);
      pins[sp.id].setRadius(st.pin.radius);
    }
  }
  pins[state.selectedId]?.bringToFront();
}

function drawHome() {
  homeLayer.clearLayers();
  const { home, radius, located } = state;
  L.circle([home.lat, home.lon], {
    radius: radius * 1000, fill: false, color: '#161616', weight: 1, opacity: 0.45, dashArray: '4 7', interactive: false,
  }).addTo(homeLayer);
  L.circleMarker([home.lat, home.lon], {
    radius: 6, color: '#FFFFFF', weight: 2.5, fillColor: '#161616', fillOpacity: 1, interactive: false,
  }).addTo(homeLayer);
  if (located) {
    L.circleMarker(located, { radius: 7, color: '#FFFFFF', weight: 2.5, fillColor: '#2B5FB3', fillOpacity: 1, interactive: false }).addTo(homeLayer);
  }
}

function fitHome() {
  const size = map.getSize();
  map.fitBounds(L.latLng(state.home.lat, state.home.lon).toBounds(state.radius * 2000), {
    paddingTopLeft: [16, Math.min(110, size.y * 0.18)],
    paddingBottomRight: [16, Math.min(150, size.y * 0.25)],
    animate: false,
  });
}

function selectSpot(id) {
  state.selectedId = id;
  state.sheet = 'card';
  state.settingsOpen = false;
  render();
  const sp = state.data.spots.find((s) => s.id === id);
  if (!sp) return;
  const size = map.getSize();
  map.flyToBounds(L.latLng(sp.lat, sp.lon).toBounds(Math.max(sp.radiusM, 1500) * 5), {
    paddingTopLeft: [24, Math.min(110, size.y * 0.15)],
    paddingBottomRight: [24, Math.min(460, size.y * 0.58)],
    maxZoom: 13,
    duration: 0.8,
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
        el('span', { className: 'sub', textContent: `${x.sp.place ? 'у ' + x.sp.place + ' · ' : ''}${x.sp.dayLabel} · ${x.sp.time}` })),
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
  axis.append(
    el('span', { textContent: `${start.getDate()} ${MONTHS_SHORT[start.getMonth()]}` }),
    el('span', { textContent: `${mid.getDate()} ${MONTHS_SHORT[mid.getMonth()]}` }),
    el('span', { textContent: 'сегодня' }),
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

  // Название уже может содержать деревню («Лес у Pokój») — тогда не повторяем её.
  const place = sp.place && !sp.forest.includes(sp.place) ? `у ${sp.place} · ` : '';

  const head = el('div', {},
    el('div', { className: 'card-title', textContent: sp.forest }),
    el('div', { className: 'card-place', textContent: `${place}${dist} км от дома` }),
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
  $('credit').textContent = TILES.credit;
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
    if (state.storms) strikeLayer.addTo(map);
    else map.removeLayer(strikeLayer);
    render();
  };
  $('locateBtn').onclick = () => {
    const fly = (ll) => map.flyTo(ll, 11, { duration: 0.8 });
    const fallback = () => fly([state.home.lat, state.home.lon]);
    if (!navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition(
      (p) => {
        state.located = [p.coords.latitude, p.coords.longitude];
        drawHome();
        fly(state.located);
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
    const finds = await fetch('/api/finds').then((r) => (r.ok ? r.json() : null));
    if (finds && typeof finds === 'object') state.marks = { ...finds, ...state.marks };
  } catch {}

  $('radius').value = state.radius;
  $('homeLabel').value = state.home.label;

  initMap();
  drawSpots();
  drawHome();
  fitHome();
  wire();
  render();

  if (problem) {
    $('statusText').textContent = `Нет данных: ${problem}. Запустите npm run update`;
    $('status').classList.add('stale');
  }
}

boot();
