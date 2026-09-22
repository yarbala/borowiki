// Единственное место с настройками региона и константами модели.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
export const REGIONS_FILE = path.join(ROOT, 'data', 'regions.json');

/** Область по умолчанию — та, с которой проект начинался. */
const DEFAULT_REGION = { slug: 'wroclaw', label: 'Вроцлав', lat: 51.1079, lon: 17.0385, radiusKm: 200 };

/**
 * Областей может быть несколько, и они лежат рядом: у каждой свои кадры молний
 * и свои готовые данные. Одна из них активна — её и показывает приложение.
 */
export function loadRegions() {
  try {
    const j = JSON.parse(fs.readFileSync(REGIONS_FILE, 'utf8'));
    if (Array.isArray(j.regions) && j.regions.length) {
      return { active: j.active || j.regions[0].slug, regions: j.regions };
    }
  } catch {}
  return { active: DEFAULT_REGION.slug, regions: [DEFAULT_REGION] };
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Имя папки для области: «Краков» → «krakov». Кириллицу переводим в латиницу. */
export function slugify(label, lat, lon) {
  const s = String(label || '')
    .toLowerCase()
    .split('')
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || `p${Math.round(lat * 100)}_${Math.round(lon * 100)}`.replace(/-/g, 'm');
}

const all = loadRegions();
/** Сборку можно запустить для конкретной области, не переключая активную. */
const wanted = process.env.BOROWIKI_REGION || all.active;
export const REGION = all.regions.find((r) => r.slug === wanted) || all.regions[0];

export const HOME = { lat: REGION.lat, lon: REGION.lon, label: REGION.label };

/** Радиус покрытия данными, км. Ползунок в интерфейсе работает внутри него. */
export const DATA_RADIUS_KM = REGION.radiusKm || 200;

/** Кадры молний привязаны к прямоугольнику области — поэтому лежат у каждой свои. */
export const FRAMES_DIR = path.join(ROOT, 'data', 'regions', REGION.slug, 'frames');

/** Готовые данные области: пятна, обзорный слой лесов, снимки истории. */
export const REGION_DATA_DIR = path.join(ROOT, 'public', 'data', 'regions', REGION.slug);

/** Тайлы лесов и кэш погоды общие: они не зависят от того, какая область активна. */
export const TILES_DIR = path.join(ROOT, 'data', 'tiles');
export const WEATHER_CACHE_DIR = path.join(ROOT, 'data', 'cache');

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
