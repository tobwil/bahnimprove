import type { DayModel } from '../sim/model.ts';
import { inGermany } from '../sim/model.ts';
import type { TrainState } from '../sim/live.ts';
import type { Incident } from '../sim/types.ts';
import { shortName } from '../sim/text.ts';
import { drawText, textWidth } from './font.ts';
import type { MapData } from './mapdata.ts';

/** Farbe "#rrggbb" → 32-Bit-Pixel (ImageData ist auf Little-Endian ABGR). */
export function px(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  return ((255 << 24) | ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff)) >>> 0;
}

const C = {
  sea: px('#0b1326'),
  wave: px('#13213d'),
  land: px('#1a2532'),
  landSpeck: px('#1e2b3a'),
  de: px('#1d3428'),
  deSpeck: px('#234030'),
  border: px('#33475e'),
  deBorder: px('#4f7a5c'),
  track: [px('#2c3a50'), px('#3d4e69'), px('#566a8a')],
  station: px('#8fa0b8'),
  hub: px('#e8eef7'),
  label: px('#cfd9e6'),
  labelShadow: px('#0b1326'),
  route: px('#9ad1ff'),
  select: px('#ffffff'),
};

export const DELAY_COLORS = [
  { max: 6, color: '#4ade80', tail: '#1f7a45' },
  { max: 16, color: '#facc15', tail: '#8a6d0c' },
  { max: 31, color: '#fb923c', tail: '#8c4a17' },
  { max: Infinity, color: '#f43f5e', tail: '#7f1d33' },
];
const TRAIN_PX = DELAY_COLORS.map((d) => ({ max: d.max, head: px(d.color), tail: px(d.tail) }));

const SPRITES: Record<string, { rows: string[]; colors: Record<string, number> }> = {
  block: { rows: ['..r..', '.rwr.', '.rwr.', 'rrrrr', 'rrwrr'], colors: { r: px('#f43f5e'), w: px('#ffffff') } },
  warn: { rows: ['..y..', '.yky.', '.yky.', 'yyyyy', 'yykyy'], colors: { y: px('#facc15'), k: px('#1a1a1a') } },
  bau: { rows: ['oo.oo', 'o.o.o', '.....'], colors: { o: px('#fb923c') } },
  medic: { rows: ['.w.', 'www', '.w.'], colors: { w: px('#ffffff') } },
  repair: { rows: ['c.c', '.c.', 'c.c'], colors: { c: px('#7dd3fc') } },
};

const BOUNDS = { minLon: 5.6, maxLon: 15.3, minLat: 47.15, maxLat: 55.15 };
const COS_LAT = Math.cos((51.2 * Math.PI) / 180);

export interface Hit {
  type: 'train' | 'station';
  id: number;
}

export class PixelMap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  pixelSize = 3;
  w = 0;
  h = 0;
  private image!: ImageData;
  private frameBuf!: Uint32Array;
  private staticBuf!: Uint32Array;
  zoom = 1;
  centerLon = (BOUNDS.minLon + BOUNDS.maxLon) / 2;
  centerLat = (BOUNDS.minLat + BOUNDS.maxLat) / 2;
  private baseScale = 1;
  private edges: { a: number; b: number; n: number }[] = [];
  private stationXY: Float32Array = new Float32Array(0);
  private lastTrains: { x: number; y: number; trip: number }[] = [];
  private dirty = true;

  constructor(canvas: HTMLCanvasElement, private mapData: MapData, private model: DayModel) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.setModel(model);
  }

  setModel(model: DayModel) {
    this.model = model;
    const usage = new Map<number, { a: number; b: number; n: number }>();
    for (const t of model.trips) {
      for (let i = 0; i + 1 < t.stops.length; i++) {
        const a = Math.min(t.stops[i], t.stops[i + 1]), b = Math.max(t.stops[i], t.stops[i + 1]);
        const k = a * 100000 + b;
        const e = usage.get(k);
        if (e) e.n++;
        else usage.set(k, { a, b, n: 1 });
      }
    }
    this.edges = [...usage.values()].sort((x, y) => x.n - y.n);
    this.dirty = true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.pixelSize = rect.width < 700 ? 2 : 3;
    const w = Math.max(64, Math.floor(rect.width / this.pixelSize));
    const h = Math.max(64, Math.floor(rect.height / this.pixelSize));
    if (w === this.w && h === this.h && !this.dirty) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.image = this.ctx.createImageData(w, h);
    this.frameBuf = new Uint32Array(this.image.data.buffer);
    this.staticBuf = new Uint32Array(w * h);
    this.baseScale = Math.min(w / ((BOUNDS.maxLon - BOUNDS.minLon) * COS_LAT), h / (BOUNDS.maxLat - BOUNDS.minLat)) * 0.96;
    this.dirty = true;
  }

  get scale() {
    return this.baseScale * this.zoom;
  }

  project(lon: number, lat: number): [number, number] {
    return [this.w / 2 + (lon - this.centerLon) * COS_LAT * this.scale, this.h / 2 - (lat - this.centerLat) * this.scale];
  }

  unproject(x: number, y: number): [number, number] {
    return [this.centerLon + (x - this.w / 2) / (COS_LAT * this.scale), this.centerLat - (y - this.h / 2) / this.scale];
  }

  /** CSS-Pixel relativ zum Canvas → Kartenpixel */
  toMapPixel(cssX: number, cssY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [(cssX / rect.width) * this.w, (cssY / rect.height) * this.h];
  }

  zoomAt(factor: number, mx: number, my: number) {
    const [lon, lat] = this.unproject(mx, my);
    this.zoom = Math.min(10, Math.max(1, this.zoom * factor));
    // Punkt unter dem Cursor festhalten
    const [nx, ny] = this.project(lon, lat);
    this.pan(nx - mx, ny - my);
  }

  pan(dx: number, dy: number) {
    this.centerLon += dx / (COS_LAT * this.scale);
    this.centerLat -= dy / this.scale;
    this.centerLon = Math.min(BOUNDS.maxLon + 3, Math.max(BOUNDS.minLon - 3, this.centerLon));
    this.centerLat = Math.min(BOUNDS.maxLat + 2, Math.max(BOUNDS.minLat - 2, this.centerLat));
    this.dirty = true;
  }

  focus(lon: number, lat: number, zoom?: number) {
    if (zoom) this.zoom = zoom;
    this.centerLon = lon;
    this.centerLat = lat;
    this.dirty = true;
  }

  private renderStatic() {
    const { w, h } = this;
    const buf = this.staticBuf;
    // Meer mit Wellenmuster
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        buf[y * w + x] = y % 6 === 0 && (x + ((y / 6) | 0) * 3) % 9 < 2 ? C.wave : C.sea;
      }
    }
    // Länder per Scanline füllen, Besitzer je Pixel merken (für Grenzen)
    const owner = new Int16Array(w * h).fill(-1);
    this.mapData.countries.forEach((country, ci) => {
      const rings = country.rings.map((r) => r.map(([lon, lat]) => this.project(lon, lat)));
      let minY = Infinity, maxY = -Infinity;
      for (const r of rings) for (const [, y] of r) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
      const xs: number[] = [];
      for (let y = y0; y <= y1; y++) {
        const sy = y + 0.5;
        xs.length = 0;
        for (const r of rings) {
          for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const [xi, yi] = r[i], [xj, yj] = r[j];
            if ((yi > sy) !== (yj > sy)) xs.push(xi + ((sy - yi) / (yj - yi)) * (xj - xi));
          }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
          for (let x = xa; x <= xb; x++) owner[y * w + x] = ci;
        }
      }
    });
    const countries = this.mapData.countries;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = owner[i];
        if (o < 0) continue;
        const de = countries[o].germany;
        const speck = (x * 7 + y * 13) % 17 === 0;
        buf[i] = de ? (speck ? C.deSpeck : C.de) : speck ? C.landSpeck : C.land;
        const r = x + 1 < w ? owner[i + 1] : o, d = y + 1 < h ? owner[i + w] : o;
        if ((r !== o && r >= 0) || (d !== o && d >= 0)) {
          buf[i] = de || countries[r]?.germany || countries[d]?.germany ? C.deBorder : C.border;
        }
      }
    }
    // Strecken
    const st = this.model.stations;
    this.stationXY = new Float32Array(st.length * 2);
    st.forEach((s, i) => {
      const [x, y] = this.project(s.lon, s.lat);
      this.stationXY[i * 2] = x;
      this.stationXY[i * 2 + 1] = y;
    });
    const maxN = this.edges.length ? this.edges[this.edges.length - 1].n : 1;
    for (const e of this.edges) {
      const level = e.n > maxN * 0.35 ? 2 : e.n > maxN * 0.1 ? 1 : 0;
      this.line(buf, this.stationXY[e.a * 2], this.stationXY[e.a * 2 + 1], this.stationXY[e.b * 2], this.stationXY[e.b * 2 + 1], C.track[level]);
    }
    // Bahnhöfe
    const used = new Set<number>();
    for (const e of this.edges) { used.add(e.a); used.add(e.b); }
    for (const i of used) {
      const s = st[i];
      if (/\(Gr\)|Grenze/.test(s.name)) continue;
      const x = Math.round(this.stationXY[i * 2]), y = Math.round(this.stationXY[i * 2 + 1]);
      if (s.weight > 300) this.rect(buf, x - 1, y - 1, 2, 2, C.hub);
      else this.set(buf, x, y, s.weight > 100 ? C.hub : C.station);
    }
    this.renderLabels(buf, used);
  }

  private renderLabels(buf: Uint32Array, used: Set<number>) {
    const st = this.model.stations;
    const candidates = [...used]
      .filter((i) => inGermany(st[i]) && !/\(Gr\)|Grenze/.test(st[i].name))
      .sort((a, b) => st[b].weight - st[a].weight);
    const taken: { x: number; y: number; w: number; h: number }[] = [];
    const names = new Set<string>();
    const maxLabels = Math.max(8, Math.round(14 * this.zoom * Math.min(1.6, (this.w * this.h) / 120000)));
    for (const i of candidates) {
      if (taken.length >= maxLabels) break;
      const name = shortName(st[i].name).split(/[ ,]/)[0];
      if (names.has(name) && this.zoom < 3) continue;
      const label = this.zoom >= 3 ? shortName(st[i].name) : name;
      const x = Math.round(this.stationXY[i * 2]), y = Math.round(this.stationXY[i * 2 + 1]);
      const tw = textWidth(label);
      const opts = [
        { x: x + 3, y: y - 2 },
        { x: x - tw - 3, y: y - 2 },
        { x: x - (tw >> 1), y: y - 8 },
        { x: x - (tw >> 1), y: y + 3 },
      ];
      const spot = opts.find((o) =>
        o.x > 1 && o.y > 1 && o.x + tw < this.w - 1 && o.y + 6 < this.h &&
        !taken.some((r) => o.x < r.x + r.w + 2 && o.x + tw + 2 > r.x && o.y < r.y + r.h + 1 && o.y + 6 > r.y),
      );
      if (!spot) continue;
      taken.push({ x: spot.x, y: spot.y, w: tw, h: 5 });
      names.add(name);
      drawText(buf, this.w, this.h, spot.x, spot.y, label, C.label, C.labelShadow);
    }
  }

  private set(buf: Uint32Array, x: number, y: number, c: number) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) buf[y * this.w + x] = c;
  }

  private rect(buf: Uint32Array, x: number, y: number, w: number, h: number, c: number) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(buf, x + i, y + j, c);
  }

  private line(buf: Uint32Array, x0f: number, y0f: number, x1f: number, y1f: number, c: number) {
    let x0 = Math.round(x0f), y0 = Math.round(y0f);
    const x1 = Math.round(x1f), y1 = Math.round(y1f);
    if ((x0 < 0 && x1 < 0) || (y0 < 0 && y1 < 0) || (x0 >= this.w && x1 >= this.w) || (y0 >= this.h && y1 >= this.h)) return;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 4000; guard++) {
      this.set(buf, x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  private sprite(buf: Uint32Array, name: keyof typeof SPRITES, cx: number, cy: number) {
    const s = SPRITES[name];
    const ox = cx - (s.rows[0].length >> 1), oy = cy - (s.rows.length >> 1);
    s.rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const c = s.colors[row[i]];
        if (c !== undefined) this.set(buf, ox + i, oy + j, c);
      }
    });
  }

  /** Zeichnet einen Frame. `blink` wechselt ca. 2× pro Sekunde. */
  draw(trains: TrainState[], incidents: Incident[], selected: { train?: number; station?: number }, blink: boolean) {
    this.resize();
    if (this.dirty) {
      this.renderStatic();
      this.dirty = false;
    }
    const buf = this.frameBuf;
    buf.set(this.staticBuf);
    const xy = this.stationXY;
    const m = this.model;

    // Route des ausgewählten Zugs
    if (selected.train !== undefined) {
      const T = m.trips[selected.train];
      for (let i = 0; i + 1 < T.stops.length; i++) {
        const a = T.stops[i], b = T.stops[i + 1];
        this.line(buf, xy[a * 2], xy[a * 2 + 1], xy[b * 2], xy[b * 2 + 1], C.route);
      }
    }

    // Störungen
    for (const inc of incidents) {
      const [x, y] = this.project(inc.lon, inc.lat);
      const rx = Math.round(x), ry = Math.round(y);
      if (inc.kind === 'bau') this.sprite(buf, 'bau', rx, ry);
      else if (inc.kind === 'notarzt') { if (blink) this.sprite(buf, 'medic', rx, ry - 3); }
      else if (inc.kind === 'fahrzeug') { if (blink) this.sprite(buf, 'repair', rx, ry - 3); }
      else if (blink || !inc.blocking) this.sprite(buf, inc.blocking ? 'block' : 'warn', rx, ry - 3);
    }

    // Züge – pünktliche zuerst, damit verspätete obenauf liegen
    const sorted = [...trains].sort((a, b) => a.delay - b.delay);
    this.lastTrains = [];
    for (const s of sorted) {
      const T = m.trips[s.trip];
      const a = T.stops[s.stop];
      const b = T.stops[Math.min(s.stop + 1, T.stops.length - 1)];
      const ax = xy[a * 2], ay = xy[a * 2 + 1], bx = xy[b * 2], by = xy[b * 2 + 1];
      const x = ax + (bx - ax) * s.progress, y = ay + (by - ay) * s.progress;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const dx = (bx - ax) / len, dy = (by - ay) / len;
      const col = TRAIN_PX.find((c) => s.delay < c.max)!;
      const rx = Math.round(x), ry = Math.round(y);
      if (!s.atStation) {
        this.set(buf, Math.round(x - dx * 2), Math.round(y - dy * 2), col.tail);
        this.set(buf, Math.round(x - dx), Math.round(y - dy), col.tail);
      }
      this.set(buf, rx, ry, col.head);
      // Ab mittlerem Zoom wird der Zug zum 2×2-Sprite
      if (this.zoom >= 2) this.rect(buf, rx, ry, 2, 2, col.head);
      this.lastTrains.push({ x, y, trip: s.trip });
      if (s.trip === selected.train) {
        const c = blink ? C.select : col.head;
        for (let i = -2; i <= 2; i++) {
          this.set(buf, rx + i, ry - 3, c); this.set(buf, rx + i, ry + 3, c);
          this.set(buf, rx - 3, ry + i, c); this.set(buf, rx + 3, ry + i, c);
        }
      }
    }
    if (selected.station !== undefined) {
      const x = Math.round(xy[selected.station * 2]), y = Math.round(xy[selected.station * 2 + 1]);
      const c = blink ? C.select : C.route;
      for (let i = -3; i <= 3; i++) {
        this.set(buf, x + i, y - 4, c); this.set(buf, x + i, y + 4, c);
        this.set(buf, x - 4, y + i, c); this.set(buf, x + 4, y + i, c);
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  hitTest(mx: number, my: number): Hit | null {
    let best: Hit | null = null;
    let bestD = 5;
    for (const t of this.lastTrains) {
      const d = Math.hypot(t.x - mx, t.y - my);
      if (d < bestD) { bestD = d; best = { type: 'train', id: t.trip }; }
    }
    if (best) return best;
    bestD = 4;
    const st = this.model.stations;
    for (let i = 0; i < st.length; i++) {
      if (st[i].weight < 20) continue;
      const d = Math.hypot(this.stationXY[i * 2] - mx, this.stationXY[i * 2 + 1] - my);
      if (d < bestD) { bestD = d; best = { type: 'station', id: i }; }
    }
    return best;
  }

  /** Bildschirmposition (CSS-Pixel relativ zum Canvas) eines Kartenpunkts, für Tooltips. */
  toCss(x: number, y: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [(x / this.w) * rect.width, (y / this.h) * rect.height];
  }

  trainPosition(trip: number): [number, number] | null {
    const t = this.lastTrains.find((x) => x.trip === trip);
    return t ? [t.x, t.y] : null;
  }
}
