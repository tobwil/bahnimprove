import type { DayModel } from '../sim/model.ts';
import { inGermany } from '../sim/model.ts';
import type { TrainState } from '../sim/live.ts';
import type { Incident } from '../sim/types.ts';
import { shortName } from '../sim/text.ts';
import { drawText, textWidth } from './font.ts';
import type { MapData } from './mapdata.ts';

/** Farbe "#rrggbb" → 32-Bit-Pixel (ImageData ist auf Little-Endian ABGR). */
export function px(hex: string, alpha = 255): number {
  const v = parseInt(hex.slice(1), 16);
  return ((alpha << 24) | ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff)) >>> 0;
}

const rgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16);
  return [v >> 16, (v >> 8) & 0xff, v & 0xff];
};

/** Mischt zwei Farben (0 = a, 1 = b) zu einem Pixelwert. */
function mix(a: string, b: string, t: number): number {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  const r = Math.round(r1 + (r2 - r1) * t), g = Math.round(g1 + (g2 - g1) * t), bl = Math.round(b1 + (b2 - b1) * t);
  return ((255 << 24) | (bl << 16) | (g << 8) | r) >>> 0;
}

/** Palette für Nacht (erste Farbe) und Tag (zweite Farbe). */
const PALETTE = {
  sea: ['#060a16', '#0d2142'],
  wave: ['#0b1428', '#163463'],
  land: ['#0d1220', '#1e2738'],
  landSpeck: ['#111829', '#232e42'],
  de: ['#0e1a1a', '#1f3b2d'],
  deSpeck: ['#122222', '#264736'],
  border: ['#1f2a40', '#3a4a66'],
  deBorder: ['#2c4a44', '#5c8a6a'],
  track0: ['#18213a', '#33415e'],
  track1: ['#24304f', '#46587c'],
  track2: ['#34446b', '#6177a0'],
} as const;

const C = {
  hub: px('#f3f6ff'),
  station: px('#9aa6c4'),
  lamp: px('#ffc56b'),
  lampDim: px('#b3803a'),
  label: px('#e3e9f8'),
  labelShadow: px('#05070f'),
  route: px('#ffc56b'),
  routeGlow: px('#ff9e3d'),
  select: px('#ffffff'),
  hot: [px('#ff4f6e'), px('#c23a55'), px('#7d2538')],
};

export const DELAY_COLORS = [
  { max: 6, color: '#3ee08f', tail: '#17784a' },
  { max: 16, color: '#ffd447', tail: '#8f7313' },
  { max: 31, color: '#ff9a3c', tail: '#91501a' },
  { max: Infinity, color: '#ff4f6e', tail: '#8a2236' },
];
const TRAIN_PX = DELAY_COLORS.map((d) => ({ max: d.max, head: px(d.color), tail: px(d.tail) }));
/** Fahrt ohne Echtzeitdaten */
const TRAIN_UNKNOWN = { max: Infinity, head: px('#7a84a8'), tail: px('#353f5f') };

const SPRITES: Record<string, { rows: string[]; colors: Record<string, number> }> = {
  block: { rows: ['..r..', '.rwr.', '.rwr.', 'rrrrr', 'rrwrr'], colors: { r: px('#ff4f6e'), w: px('#ffffff') } },
  warn: { rows: ['..y..', '.yky.', '.yky.', 'yyyyy', 'yykyy'], colors: { y: px('#ffd447'), k: px('#1a1a1a') } },
  bau: { rows: ['oo.oo', 'o.o.o', '.....'], colors: { o: px('#ff9a3c') } },
  medic: { rows: ['.w.', 'www', '.w.'], colors: { w: px('#ffffff') } },
  repair: { rows: ['c.c', '.c.', 'c.c'], colors: { c: px('#8ab4ff') } },
};

const BOUNDS = { minLon: 5.7, maxLon: 15.2, minLat: 47.25, maxLat: 55.08 };
const COS_LAT = Math.cos((51.2 * Math.PI) / 180);

/** Helligkeit 0 (Nacht) … 1 (Tag) für Minute im Verkehrstag; Mitte Oktober ca. 7:45–18:30 Uhr. */
export function daylight(minute: number): number {
  const m = ((minute % 1440) + 1440) % 1440;
  const rise = 7 * 60 + 45, set = 18 * 60 + 30, twilight = 50;
  if (m < rise - twilight || m > set + twilight) return 0;
  if (m < rise + twilight) return (m - (rise - twilight)) / (2 * twilight);
  if (m > set - twilight) return 1 - (m - (set - twilight)) / (2 * twilight);
  return 1;
}

export interface Hit {
  type: 'train' | 'station';
  id: number;
}

export interface Hotspot {
  station: number;
  /** 0…1 */
  intensity: number;
}

export interface Frame {
  trains: TrainState[];
  incidents: Incident[];
  hotspots: Hotspot[];
  selected: { train?: number; station?: number };
  /** Minute im Verkehrstag (für Tag/Nacht) */
  minute: number;
  /** Laufzeit in ms (für Animationen) */
  now: number;
}

export class PixelMap {
  private ctx: CanvasRenderingContext2D;
  private glowCtx: CanvasRenderingContext2D;
  pixelSize = 3;
  w = 0;
  h = 0;
  private image!: ImageData;
  private glowImage!: ImageData;
  private buf!: Uint32Array;
  private glow!: Uint32Array;
  private staticBuf!: Uint32Array;
  private staticGlow!: Uint32Array;
  zoom = 1;
  centerLon = (BOUNDS.minLon + BOUNDS.maxLon) / 2;
  centerLat = (BOUNDS.minLat + BOUNDS.maxLat) / 2;
  /** Vom Bottom-Sheet bzw. HUD verdeckte Ränder in CSS-Pixeln */
  insets = { top: 0, bottom: 0 };
  private baseScale = 1;
  private edges: { a: number; b: number; n: number }[] = [];
  private stationXY = new Float32Array(0);
  private lastTrains: { x: number; y: number; trip: number }[] = [];
  private dirty = true;
  private lightLevel = -1;
  private cityLights: { station: number; dx: number; dy: number; warm: boolean }[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly glowCanvas: HTMLCanvasElement,
    private mapData: MapData,
    private model: DayModel,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.glowCtx = glowCanvas.getContext('2d')!;
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
    // Stadtlichter: feste Muster um große Bahnhöfe
    this.cityLights = [];
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    model.stations.forEach((s, i) => {
      if (s.weight < 60 || /\(Gr\)|Grenze/.test(s.name)) return;
      const n = Math.min(40, Math.round(s.weight / 22));
      const r = 1.5 + Math.sqrt(s.weight) / 7;
      for (let k = 0; k < n; k++) {
        const a = rand() * Math.PI * 2, d = Math.pow(rand(), 0.7) * r;
        this.cityLights.push({ station: i, dx: Math.cos(a) * d, dy: Math.sin(a) * d * 0.8, warm: rand() > 0.25 });
      }
    });
    this.dirty = true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.pixelSize = rect.width < 700 ? 2 : 3;
    const w = Math.max(64, Math.floor(rect.width / this.pixelSize));
    const h = Math.max(64, Math.floor(rect.height / this.pixelSize));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    for (const c of [this.canvas, this.glowCanvas]) {
      c.width = w;
      c.height = h;
    }
    this.image = this.ctx.createImageData(w, h);
    this.glowImage = this.glowCtx.createImageData(w, h);
    this.buf = new Uint32Array(this.image.data.buffer);
    this.glow = new Uint32Array(this.glowImage.data.buffer);
    this.staticBuf = new Uint32Array(w * h);
    this.staticGlow = new Uint32Array(w * h);
    this.fit();
    this.dirty = true;
  }

  /** Sichtbarer Bereich in Kartenpixeln (ohne HUD und Sheet). */
  private get view() {
    const s = this.w / (this.canvas.getBoundingClientRect().width || 1);
    const top = this.insets.top * s, bottom = this.insets.bottom * s;
    return { top, bottom, cy: top + (this.h - top - bottom) / 2, height: Math.max(40, this.h - top - bottom) };
  }

  private fit() {
    const v = this.view;
    this.baseScale = Math.min(this.w / ((BOUNDS.maxLon - BOUNDS.minLon) * COS_LAT), v.height / (BOUNDS.maxLat - BOUNDS.minLat)) * 0.94;
  }

  setInsets(top: number, bottom: number) {
    if (Math.abs(top - this.insets.top) < 1 && Math.abs(bottom - this.insets.bottom) < 1) return;
    this.insets = { top, bottom };
    this.fit();
    this.dirty = true;
  }

  get scale() {
    return this.baseScale * this.zoom;
  }

  project(lon: number, lat: number): [number, number] {
    return [this.w / 2 + (lon - this.centerLon) * COS_LAT * this.scale, this.view.cy - (lat - this.centerLat) * this.scale];
  }

  unproject(x: number, y: number): [number, number] {
    return [this.centerLon + (x - this.w / 2) / (COS_LAT * this.scale), this.centerLat - (y - this.view.cy) / this.scale];
  }

  toMapPixel(cssX: number, cssY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [(cssX / rect.width) * this.w, (cssY / rect.height) * this.h];
  }

  toCss(x: number, y: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [(x / this.w) * rect.width, (y / this.h) * rect.height];
  }

  zoomAt(factor: number, mx: number, my: number) {
    const [lon, lat] = this.unproject(mx, my);
    this.zoom = Math.min(12, Math.max(1, this.zoom * factor));
    const [nx, ny] = this.project(lon, lat);
    this.pan(nx - mx, ny - my);
  }

  pan(dx: number, dy: number) {
    this.centerLon = Math.min(BOUNDS.maxLon + 3, Math.max(BOUNDS.minLon - 3, this.centerLon + dx / (COS_LAT * this.scale)));
    this.centerLat = Math.min(BOUNDS.maxLat + 2, Math.max(BOUNDS.minLat - 2, this.centerLat - dy / this.scale));
    this.dirty = true;
  }

  focus(lon: number, lat: number, zoom?: number) {
    if (zoom) this.zoom = zoom;
    this.centerLon = lon;
    this.centerLat = lat;
    this.dirty = true;
  }

  reset() {
    this.zoom = 1;
    this.focus((BOUNDS.minLon + BOUNDS.maxLon) / 2, (BOUNDS.minLat + BOUNDS.maxLat) / 2);
  }

  private renderStatic(light: number) {
    const { w, h } = this;
    const buf = this.staticBuf;
    const glow = this.staticGlow;
    glow.fill(0);
    const P = Object.fromEntries(Object.entries(PALETTE).map(([k, [n, d]]) => [k, mix(n, d, light)])) as Record<keyof typeof PALETTE, number>;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) buf[y * w + x] = y % 6 === 0 && (x + ((y / 6) | 0) * 3) % 9 < 2 ? P.wave : P.sea;
    }
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
        buf[i] = de ? (speck ? P.deSpeck : P.de) : speck ? P.landSpeck : P.land;
        const r = x + 1 < w ? owner[i + 1] : o, d = y + 1 < h ? owner[i + w] : o;
        if ((r !== o && r >= 0) || (d !== o && d >= 0)) buf[i] = de || countries[r]?.germany || countries[d]?.germany ? P.deBorder : P.border;
      }
    }
    const st = this.model.stations;
    this.stationXY = new Float32Array(st.length * 2);
    st.forEach((s, i) => {
      const [x, y] = this.project(s.lon, s.lat);
      this.stationXY[i * 2] = x;
      this.stationXY[i * 2 + 1] = y;
    });
    // Stadtlichter bei Nacht
    const night = 1 - light;
    if (night > 0.05) {
      const spread = Math.min(2.2, Math.max(1, this.zoom * 0.6));
      for (const l of this.cityLights) {
        const x = Math.round(this.stationXY[l.station * 2] + l.dx * spread), y = Math.round(this.stationXY[l.station * 2 + 1] + l.dy * spread);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        buf[y * w + x] = night > 0.5 ? (l.warm ? C.lampDim : P.border) : buf[y * w + x];
        if (l.warm && night > 0.5) glow[y * w + x] = C.lampDim;
      }
    }
    const maxN = this.edges.length ? this.edges[this.edges.length - 1].n : 1;
    for (const e of this.edges) {
      const level = e.n > maxN * 0.35 ? P.track2 : e.n > maxN * 0.1 ? P.track1 : P.track0;
      this.line(buf, this.stationXY[e.a * 2], this.stationXY[e.a * 2 + 1], this.stationXY[e.b * 2], this.stationXY[e.b * 2 + 1], level);
    }
    const used = new Set<number>();
    for (const e of this.edges) { used.add(e.a); used.add(e.b); }
    for (const i of used) {
      const s = st[i];
      if (/\(Gr\)|Grenze/.test(s.name)) continue;
      const x = Math.round(this.stationXY[i * 2]), y = Math.round(this.stationXY[i * 2 + 1]);
      if (s.weight > 300) {
        this.rect(buf, x - 1, y - 1, 2, 2, night > 0.5 ? C.lamp : C.hub);
        if (night > 0.3) this.rect(glow, x - 1, y - 1, 2, 2, C.lamp);
      } else this.set(buf, x, y, s.weight > 100 ? C.hub : C.station);
    }
    this.renderLabels(buf, used);
  }

  private renderLabels(buf: Uint32Array, used: Set<number>) {
    const st = this.model.stations;
    const candidates = [...used].filter((i) => inGermany(st[i]) && !/\(Gr\)|Grenze/.test(st[i].name)).sort((a, b) => st[b].weight - st[a].weight);
    const taken: { x: number; y: number; w: number; h: number }[] = [];
    const names = new Set<string>();
    const maxLabels = Math.max(9, Math.round(14 * this.zoom * Math.min(1.6, (this.w * this.h) / 120000)));
    for (const i of candidates) {
      if (taken.length >= maxLabels) break;
      const name = shortName(st[i].name).split(/[ ,]/)[0];
      if (names.has(name) && this.zoom < 3) continue;
      const label = this.zoom >= 3 ? shortName(st[i].name) : name;
      const x = Math.round(this.stationXY[i * 2]), y = Math.round(this.stationXY[i * 2 + 1]);
      const tw = textWidth(label);
      const opts = [
        { x: x + 4, y: y - 2 },
        { x: x - tw - 4, y: y - 2 },
        { x: x - (tw >> 1), y: y - 9 },
        { x: x - (tw >> 1), y: y + 4 },
      ];
      const spot = opts.find(
        (o) =>
          o.x > 1 && o.y > 1 && o.x + tw < this.w - 1 && o.y + 6 < this.h &&
          !taken.some((r) => o.x < r.x + r.w + 3 && o.x + tw + 3 > r.x && o.y < r.y + r.h + 2 && o.y + 7 > r.y),
      );
      if (!spot) continue;
      taken.push({ x: spot.x, y: spot.y, w: tw, h: 5 });
      names.add(name);
      drawText(buf, this.w, this.h, spot.x, spot.y, label, C.label, C.labelShadow);
    }
  }

  private set(buf: Uint32Array, x: number, y: number, c: number) {
    x = Math.round(x);
    y = Math.round(y);
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
    for (let guard = 0; guard < 6000; guard++) {
      this.set(buf, x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  private ring(buf: Uint32Array, cx: number, cy: number, r: number, c: number) {
    const steps = Math.max(12, Math.round(r * 7));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      this.set(buf, cx + Math.cos(a) * r, cy + Math.sin(a) * r, c);
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

  draw(f: Frame) {
    this.resize();
    const light = Math.round(daylight(f.minute) * 16) / 16;
    if (this.dirty || light !== this.lightLevel) {
      this.renderStatic(light);
      this.lightLevel = light;
      this.dirty = false;
    }
    const { buf, glow } = this;
    buf.set(this.staticBuf);
    glow.set(this.staticGlow);
    const xy = this.stationXY;
    const m = this.model;
    const blink = Math.floor(f.now / 420) % 2 === 0;

    // Brennpunkte: pulsierende Ringe
    for (const hs of f.hotspots) {
      const x = xy[hs.station * 2], y = xy[hs.station * 2 + 1];
      const phase = ((f.now / 1400 + hs.station * 0.137) % 1 + 1) % 1;
      const r = 2 + phase * (4 + hs.intensity * 8);
      const c = C.hot[Math.min(2, Math.floor(phase * 3))];
      this.ring(buf, x, y, r, c);
      this.ring(glow, x, y, r, c);
    }

    if (f.selected.train !== undefined) {
      const T = m.trips[f.selected.train];
      for (let i = 0; i + 1 < T.stops.length; i++) {
        const a = T.stops[i], b = T.stops[i + 1];
        this.line(buf, xy[a * 2], xy[a * 2 + 1], xy[b * 2], xy[b * 2 + 1], C.route);
        this.line(glow, xy[a * 2], xy[a * 2 + 1], xy[b * 2], xy[b * 2 + 1], C.routeGlow);
      }
    }

    for (const inc of f.incidents) {
      const [x, y] = this.project(inc.lon, inc.lat);
      const rx = Math.round(x), ry = Math.round(y);
      if (inc.kind === 'bau') this.sprite(buf, 'bau', rx, ry);
      else if (inc.kind === 'notarzt') { if (blink) this.sprite(buf, 'medic', rx, ry - 3); }
      else if (inc.kind === 'fahrzeug') { if (blink) this.sprite(buf, 'repair', rx, ry - 3); }
      else if (blink || !inc.blocking) {
        this.sprite(buf, inc.blocking ? 'block' : 'warn', rx, ry - 3);
        this.sprite(glow, inc.blocking ? 'block' : 'warn', rx, ry - 3);
      }
    }

    const sorted = [...f.trains].sort((a, b) => Number(a.known) - Number(b.known) || a.delay - b.delay);
    this.lastTrains = [];
    const big = this.zoom >= 1.6 || this.pixelSize === 2;
    for (const s of sorted) {
      const T = m.trips[s.trip];
      const a = T.stops[s.stop];
      const b = T.stops[Math.min(s.stop + 1, T.stops.length - 1)];
      const ax = xy[a * 2], ay = xy[a * 2 + 1], bx = xy[b * 2], by = xy[b * 2 + 1];
      const x = ax + (bx - ax) * s.progress, y = ay + (by - ay) * s.progress;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const dx = (bx - ax) / len, dy = (by - ay) / len;
      const col = s.known ? TRAIN_PX.find((c) => s.delay < c.max)! : TRAIN_UNKNOWN;
      if (!s.atStation) {
        this.set(buf, x - dx * 3, y - dy * 3, col.tail);
        this.set(buf, x - dx * 2, y - dy * 2, col.tail);
      }
      if (big) this.rect(buf, Math.round(x - 0.5), Math.round(y - 0.5), 2, 2, col.head);
      else this.set(buf, x, y, col.head);
      if (s.known) {
        this.set(glow, x, y, col.head);
        if (s.delay >= 31) this.rect(glow, Math.round(x) - 1, Math.round(y) - 1, 3, 3, col.head);
      }
      this.lastTrains.push({ x, y, trip: s.trip });
      if (s.trip === f.selected.train) {
        const c = blink ? C.select : col.head;
        const rx = Math.round(x), ry = Math.round(y);
        for (let i = -3; i <= 3; i++) {
          if (Math.abs(i) < 2) continue;
          this.set(buf, rx + i, ry - 4, c); this.set(buf, rx + i, ry + 4, c);
          this.set(buf, rx - 4, ry + i, c); this.set(buf, rx + 4, ry + i, c);
        }
        this.ring(glow, rx, ry, 5, C.select);
      }
    }
    if (f.selected.station !== undefined) {
      const x = xy[f.selected.station * 2], y = xy[f.selected.station * 2 + 1];
      this.ring(buf, x, y, 5, blink ? C.select : C.route);
      this.ring(glow, x, y, 5, C.route);
    }
    this.ctx.putImageData(this.image, 0, 0);
    this.glowCtx.putImageData(this.glowImage, 0, 0);
  }

  hitTest(mx: number, my: number): Hit | null {
    let best: Hit | null = null;
    let bestD = this.pixelSize === 2 ? 9 : 6;
    for (const t of this.lastTrains) {
      const d = Math.hypot(t.x - mx, t.y - my);
      if (d < bestD) { bestD = d; best = { type: 'train', id: t.trip }; }
    }
    if (best) return best;
    bestD = this.pixelSize === 2 ? 7 : 5;
    const st = this.model.stations;
    for (let i = 0; i < st.length; i++) {
      if (st[i].weight < 20) continue;
      const d = Math.hypot(this.stationXY[i * 2] - mx, this.stationXY[i * 2 + 1] - my);
      if (d < bestD) { bestD = d; best = { type: 'station', id: i }; }
    }
    return best;
  }

  trainPosition(trip: number): [number, number] | null {
    const t = this.lastTrains.find((x) => x.trip === trip);
    return t ? [t.x, t.y] : null;
  }

  /** Bringt einen Punkt in den sichtbaren Bereich; `bottomCss` = aktuell vom Sheet verdeckte Höhe. */
  ensureVisible(lon: number, lat: number, bottomCss: number, minZoom = 1) {
    if (this.zoom < minZoom) this.zoom = minZoom;
    const s = this.w / (this.canvas.getBoundingClientRect().width || 1);
    const top = this.insets.top * s, bottom = bottomCss * s;
    const [x, y] = this.project(lon, lat);
    const margin = 16;
    if (x > margin && x < this.w - margin && y > top + margin && y < this.h - bottom - margin) {
      this.dirty = true;
      return;
    }
    const targetY = top + (this.h - top - bottom) / 2;
    this.centerLon = lon;
    this.centerLat = lat - (this.view.cy - targetY) / this.scale;
    this.dirty = true;
  }
}
