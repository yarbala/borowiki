// Единственное место с настройками региона и константами модели.
import fs from 'node:fs';
import path from 'node:path';

/** Регион можно перенести командой `npm run region -- <город>` — она пишет этот файл. */
function savedRegion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'region.json'), 'utf8'));
  } catch {
    return null;
  }
}

const region = savedRegion();

export const HOME = region?.home || { lat: 51.1079, lon: 17.0385, label: 'Вроцлав' };

/** Радиус покрытия данными, км. Ползунок в интерфейсе работает внутри него. */
export const DATA_RADIUS_KM = region?.radiusKm || 200;

/** Сколько суток гроз показываем. Пользователь просил ровно неделю. */
export const DAYS = 7;

/** Шаг сетки WMS в градусах. Родное разрешение MTG LI над Польшей — несколько км. */
export const GRID_DEG = 0.02;

/** Прямоугольник региона: DATA_RADIUS_KM вокруг дома. */
export const BBOX = (() => {
  const dLat = DATA_RADIUS_KM / 111.32;
  const dLon = DATA_RADIUS_KM / (111.32 * Math.cos((HOME.lat * Math.PI) / 180));
  return {
    minLon: +(HOME.lon - dLon).toFixed(4),
    minLat: +(HOME.lat - dLat).toFixed(4),
    maxLon: +(HOME.lon + dLon).toFixed(4),
    maxLat: +(HOME.lat + dLat).toFixed(4),
  };
})();

export const GRID = {
  width: Math.round((BBOX.maxLon - BBOX.minLon) / GRID_DEG),
  height: Math.round((BBOX.maxLat - BBOX.minLat) / GRID_DEG),
};

/** Слой молний MTG Lightning Imager в публичном сервисе EUMETSAT. Ключ не нужен. */
export const WMS = {
  base: 'https://view.eumetsat.int/geoserver/wms',
  layer: 'mtg_fd:li_afa',
  stepMinutes: 5,
};

/** Раньше этого дня спутник данных не даёт — дальше в историю уходить бессмысленно. */
export const LIGHTNING_START = '2025-05-30';

/**
 * Проверка даты по календарю: `2026-02-30` виду ГГГГ-ММ-ДД соответствует, а дню — нет.
 * Без неё такая дата молча превращалась в 2 марта, а `2026-99-99` роняла сборку.
 */
export function isCalendarDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Сильным считаем дождь от этого значения за сутки. Одно число на сервер и карту:
 * сервер ничего слабее не сохраняет, карта рисует всё, что пришло.
 */
export const RAIN_MIN_MM = 10;

/** Шаг сетки осадков, градусы. 0,1° ≈ 11 км по широте — соразмерно пятну грозы. */
export const RAIN_STEP_DEG = 0.1;

/** Кластеризация вспышек в грозовые ячейки. */
export const CLUSTER = {
  /** Перерыв дольше этого — отдельная гроза, минут. */
  gapMinutes: 45,
  /** Соседство при поиске связных областей, в ячейках сетки (2 = допускается пропуск). */
  linkCells: 2,
  /**
   * Порог накопленной силы вспышек на ячейку сетки за один проход.
   * Шкала кадра 0..6: 0 — слабый ореол вокруг грозы, 6 — ядро.
   * Отсекает ореол, оставляя реальный след грозы.
   */
  minAccum: 12,
  /** Ячейка должна хотя бы раз дойти до середины шкалы — иначе это край чужой грозы. */
  minPeak: 3,
  /** Пятна мельче этого числа ячеек — шум прибора, а не гроза над лесом. */
  minCells: 2,
};

/** Пятно = часть грозовой ячейки, попавшая в лес. */
export const SPOT = {
  minRadiusM: 500,
  maxRadiusM: 4000,
  /** Разряд засчитывается лесу, если он не дальше этого расстояния от полигона, м. */
  forestSlackM: 1200,
};

export const TZ = 'Europe/Warsaw';
