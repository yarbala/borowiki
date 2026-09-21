// Минимальный декодер векторных тайлов Mapbox (MVT) — полигоны и точки из тайлов OpenFreeMap.
// Своя реализация вместо npm-зависимостей: нужен только разбор protobuf и команд геометрии.

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  get atEnd() { return this.pos >= this.buf.length; }

  varint() {
    let result = 0, shift = 0, b;
    do {
      b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b >= 0x80);
    return result;
  }

  skip(wireType) {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.pos += this.varint();
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`неизвестный тип поля ${wireType}`);
  }

  /** Вложенное сообщение или строка: возвращает под-Reader. */
  sub() {
    const len = this.varint();
    const r = new Reader(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return r;
  }

  string() {
    const len = this.varint();
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  double() { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  float() { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
}

const zigzag = (n) => (n >>> 1) ^ -(n & 1);

function readValue(r) {
  let value = null;
  while (!r.atEnd) {
    const tag = r.varint();
    const field = tag >> 3;
    switch (field) {
      case 1: value = r.string(); break;
      case 2: value = r.float(); break;
      case 3: value = r.double(); break;
      case 4: case 5: value = r.varint(); break;
      case 6: value = zigzag(r.varint()); break;
      case 7: value = r.varint() !== 0; break;
      default: r.skip(tag & 7);
    }
  }
  return value;
}

/** Команды геометрии → массив колец/линий в координатах тайла. */
function readGeometry(data) {
  const rings = [];
  let cur = null, x = 0, y = 0, i = 0;

  while (i < data.length) {
    const cmd = data[i] & 0x7;
    const count = data[i] >> 3;
    i++;
    if (cmd === 1 || cmd === 2) {
      for (let k = 0; k < count; k++) {
        x += zigzag(data[i++]);
        y += zigzag(data[i++]);
        if (cmd === 1) {
          cur = [[x, y]];
          rings.push(cur);
        } else {
          cur.push([x, y]);
        }
      }
    } else if (cmd === 7) {
      if (cur && cur.length) cur.push([cur[0][0], cur[0][1]]);
    } else {
      break;
    }
  }
  return rings;
}

function readFeature(r) {
  const f = { tags: [], type: 0, geometry: [] };
  while (!r.atEnd) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 2) {
      const sub = r.sub();
      while (!sub.atEnd) f.tags.push(sub.varint());
    } else if (field === 3) {
      f.type = r.varint();
    } else if (field === 4) {
      const sub = r.sub();
      const raw = [];
      while (!sub.atEnd) raw.push(sub.varint());
      f.geometry = readGeometry(raw);
    } else {
      r.skip(tag & 7);
    }
  }
  return f;
}

function readLayer(r) {
  const layer = { name: '', features: [], keys: [], values: [], extent: 4096 };
  while (!r.atEnd) {
    const tag = r.varint();
    const field = tag >> 3;
    switch (field) {
      case 1: layer.name = r.string(); break;
      case 2: layer.features.push(readFeature(r.sub())); break;
      case 3: layer.keys.push(r.string()); break;
      case 4: layer.values.push(readValue(r.sub())); break;
      case 5: layer.extent = r.varint(); break;
      default: r.skip(tag & 7);
    }
  }
  return layer;
}

/**
 * @param {Buffer} buf содержимое .pbf
 * @returns {Map<string, {name:string, extent:number, features:Array}>}
 */
export function decodeTile(buf) {
  const r = new Reader(buf);
  const layers = new Map();
  while (!r.atEnd) {
    const tag = r.varint();
    if (tag >> 3 === 3) {
      const layer = readLayer(r.sub());
      layers.set(layer.name, layer);
    } else {
      r.skip(tag & 7);
    }
  }
  return layers;
}

/** Теги объекта в обычный объект. */
export function featureProps(layer, feature) {
  const props = {};
  for (let i = 0; i < feature.tags.length; i += 2) {
    props[layer.keys[feature.tags[i]]] = layer.values[feature.tags[i + 1]];
  }
  return props;
}

/** Координаты тайла → [долгота, широта]. */
export function tileToLonLat(z, tx, ty, extent, px, py) {
  const n = 2 ** z;
  const lon = ((tx + px / extent) / n) * 360 - 180;
  const yy = Math.PI * (1 - 2 * (ty + py / extent) / n);
  const lat = (Math.atan(Math.sinh(yy)) * 180) / Math.PI;
  return [lon, lat];
}

/** Площадь кольца в координатах тайла со знаком: > 0 — внешнее кольцо (по спецификации MVT v2). */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

export function lonLatToTile(z, lon, lat) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}
