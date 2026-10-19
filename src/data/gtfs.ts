/**
 * Aufbereitung der freien GTFS-Feeds von gtfs.de (Daten: DELFI e.V., CC BY 4.0):
 * Fernverkehr als ein kompakter Fahrplan für die ganze App, Regionalverkehr (RE, RB, S-Bahn)
 * in Kacheln, damit das Handy nur die Gegend lädt, die es braucht.
 * Läuft lokal (scripts/build-timetable.ts) und nachts auf dem Server (Netlify Function).
 */
import { strFromU8, unzipSync } from 'fflate';
import { lineKey } from '../sim/search.ts';
import type { Timetable, TimetableStation, TimetableTrip } from '../sim/types.ts';
import { tileKey, type RegionalIndex, type RegionalTile, type RegionalTrip } from './regional.ts';

export const FV_URL = 'https://download.gtfs.de/germany/fv_free/latest.zip';
export const RV_URL = 'https://download.gtfs.de/germany/rv_free/latest.zip';

export type Feed = (file: string) => string | undefined;

export function unzipFeed(zip: Uint8Array): Feed {
  const files = unzipSync(zip, { filter: (f) => f.name.endsWith('.txt') });
  const cache = new Map<string, string>();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const raw = files[name];
    if (!raw) return undefined;
    const text = strFromU8(raw);
    // Große Dateien nicht doppelt im Speicher halten
    if (raw.length < 5_000_000) cache.set(name, text);
    delete files[name];
    return text;
  };
}

function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** Zeilenweise über eine CSV-Datei, ohne alle Zeilen auf einmal im Speicher zu halten. */
export function eachRow(text: string | undefined, fn: (get: (col: string) => string) => void) {
  if (!text) return;
  let pos = 0;
  const nextLine = () => {
    if (pos >= text.length) return null;
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    let line = text.slice(pos, end);
    pos = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return line;
  };
  const header = splitCsvLine((nextLine() ?? '').replace(/^﻿/, ''));
  const idx = new Map(header.map((h, i) => [h, i]));
  let cells: string[] = [];
  const get = (col: string) => cells[idx.get(col) ?? -1] ?? '';
  for (let line = nextLine(); line !== null; line = nextLine()) {
    if (!line) continue;
    cells = splitCsvLine(line);
    fn(get);
  }
}

/** GTFS-Haltestellennamen sind uneinheitlich ("Mannheim, Hauptbahnhof", "S+U Berlin Hauptbahnhof" …). */
export function cleanName(raw: string, lat: number, lon: number): string {
  if (raw === 'Hauptbahnhof (oben)' && Math.abs(lat - 48.78) < 0.05 && Math.abs(lon - 9.18) < 0.05) return 'Stuttgart Hbf';
  let n = raw.trim();
  const berlin = n.match(/^S(?:\+U)? (.+?) Bhf \((.+)\)$/);
  if (berlin) n = `${berlin[2]} ${berlin[1]}`;
  n = n.replace(/^S(?:\+U)? /, '');
  const comma = n.match(/^([^,]+), (.+)$/);
  if (comma) {
    const [, city, rest] = comma;
    if (rest.startsWith(city)) n = rest;
    else n = `${city} ${rest}`;
  }
  return n
    .replace(/Hauptbahnhof/g, 'Hbf')
    .replace(/Hbf\/ZOB/g, 'Hbf')
    .replace(/ Bahnhof /g, ' ')
    .replace(/ (Busbf\/)?Bahnhof(\/ZOB)?$/, '')
    .replace(/ Bf$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function addDays(yyyymmdd: string, n: number): string {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

export function berlinToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).replaceAll('-', '');
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const weekdayOf = (d: string) => WEEKDAYS[new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay()];

function popcount(x: number): number {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
}

const toMinutes = (hms: string) => {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 60 + m + Math.round((s || 0) / 60);
};

/** Verkehrstage je service_id als Bitmaske über `dates`. */
function serviceMasks(feed: Feed, dates: string[]): Map<string, number> {
  const masks = new Map<string, number>();
  eachRow(feed('calendar.txt'), (c) => {
    let mask = 0;
    const start = c('start_date'), end = c('end_date');
    dates.forEach((d, i) => {
      if (d >= start && d <= end && c(weekdayOf(d)) === '1') mask |= 1 << i;
    });
    masks.set(c('service_id'), mask);
  });
  eachRow(feed('calendar_dates.txt'), (cd) => {
    const i = dates.indexOf(cd('date'));
    if (i < 0) return;
    const mask = masks.get(cd('service_id')) ?? 0;
    masks.set(cd('service_id'), cd('exception_type') === '1' ? mask | (1 << i) : mask & ~(1 << i));
  });
  return masks;
}

interface RawStop {
  seq: number;
  stop: string;
  arr: number;
  dep: number;
}

interface FeedTrips {
  trips: Map<string, { route: string; mask: number }>;
  routes: Map<string, { name: string; agency: string }>;
  stopTimes: Map<string, RawStop[]>;
}

function readTrips(feed: Feed, dates: string[], parentOf: (id: string) => string): FeedTrips {
  const masks = serviceMasks(feed, dates);
  const agencies = new Map<string, string>();
  eachRow(feed('agency.txt'), (a) => agencies.set(a('agency_id'), a('agency_name')));
  const routes = new Map<string, { name: string; agency: string }>();
  eachRow(feed('routes.txt'), (r) => routes.set(r('route_id'), { name: r('route_short_name') || r('route_long_name'), agency: agencies.get(r('agency_id')) ?? '' }));
  const trips = new Map<string, { route: string; mask: number }>();
  eachRow(feed('trips.txt'), (t) => {
    const mask = masks.get(t('service_id')) ?? 0;
    if (mask) trips.set(t('trip_id'), { route: t('route_id'), mask });
  });
  const stopTimes = new Map<string, RawStop[]>();
  eachRow(feed('stop_times.txt'), (st) => {
    const id = st('trip_id');
    if (!trips.has(id)) return;
    let list = stopTimes.get(id);
    if (!list) stopTimes.set(id, (list = []));
    const a = st('arrival_time') || st('departure_time'), d = st('departure_time') || st('arrival_time');
    list.push({ seq: +st('stop_sequence'), stop: parentOf(st('stop_id')), arr: toMinutes(a), dep: toMinutes(d) });
  });
  return { trips, routes, stopTimes };
}

/** Doppelte aufeinanderfolgende Halte (Gleiswechsel im selben Bahnhof) zusammenfassen. */
function mergeStops(list: RawStop[]): RawStop[] {
  list.sort((a, b) => a.seq - b.seq);
  const merged: RawStop[] = [];
  for (const st of list) {
    const prev = merged[merged.length - 1];
    if (prev && prev.stop === st.stop) prev.dep = st.dep;
    else merged.push({ ...st });
  }
  return merged;
}

export interface StaticBuild {
  timetable: Timetable;
  regional?: {
    index: RegionalIndex;
    /** Schlüssel "YYYYMMDD/kachel" */
    tiles: Map<string, RegionalTile>;
    /** trip_id → Kacheln (für das Zuschneiden der Echtzeitdaten) */
    tripTiles: Record<string, string[]>;
  };
}

export function buildStatic(fv: Feed, rv: Feed | null, opts: { start: string; fvDays: number; rvDays: number; version?: string }): StaticBuild {
  const version = opts.version ?? new Date().toISOString();
  const fvDates = Array.from({ length: opts.fvDays }, (_, i) => addDays(opts.start, i));
  const rvDates = fvDates.slice(0, opts.rvDays);

  // Haltestellen beider Feeds (gleiche IDs), Bahnsteige auf Bahnhöfe zusammenfassen
  const stopById = new Map<string, { name: string; lat: number; lon: number; parent: string }>();
  for (const feed of [fv, rv]) {
    if (!feed) continue;
    eachRow(feed('stops.txt'), (s) => {
      const id = s('stop_id');
      if (!stopById.has(id)) stopById.set(id, { name: s('stop_name'), lat: +s('stop_lat'), lon: +s('stop_lon'), parent: s('parent_station') });
    });
  }
  const parentOf = (id: string) => {
    const p = stopById.get(id)?.parent;
    return p && stopById.has(p) ? p : id;
  };

  const stationIndex = new Map<string, number>();
  const stations: TimetableStation[] = [];
  const station = (id: string) => {
    let i = stationIndex.get(id);
    if (i === undefined) {
      const raw = stopById.get(id) ?? { name: id, lat: 0, lon: 0, parent: '' };
      const lat = +raw.lat.toFixed(5), lon = +raw.lon.toFixed(5);
      i = stations.length;
      stationIndex.set(id, i);
      stations.push({ name: cleanName(raw.name, lat, lon), lat, lon, weight: 0, w: 0 });
    }
    return i;
  };

  // Fernverkehr
  const fvData = readTrips(fv, fvDates, parentOf);
  const routeNames: string[] = [];
  const routeIndex = new Map<string, number>();
  const fvTrips: TimetableTrip[] = [];
  for (const [tripId, trip] of fvData.trips) {
    const list = fvData.stopTimes.get(tripId);
    if (!list || list.length < 2) continue;
    const merged = mergeStops(list);
    const route = fvData.routes.get(trip.route) ?? { name: '?', agency: '' };
    const rKey = `${route.name}|${route.agency}`;
    if (!routeIndex.has(rKey)) {
      routeIndex.set(rKey, routeNames.length);
      routeNames.push(route.name);
    }
    const s = merged.map((x) => station(x.stop));
    const perDay = popcount(trip.mask) / fvDates.length;
    s.forEach((i) => {
      stations[i].weight++;
      stations[i].w! += perDay;
    });
    const seqs = merged.map((x) => x.seq);
    fvTrips.push({
      id: tripId,
      route: routeIndex.get(rKey)!,
      operator: route.agency,
      days: trip.mask,
      stops: s,
      times: merged.flatMap((x) => [x.arr, x.dep]),
      ...(seqs.every((q, i) => q === i) ? {} : { seqs }),
    });
  }
  fvTrips.sort((a, b) => a.times[1] - b.times[1]);
  fvData.stopTimes.clear();

  // Regionalverkehr in Kacheln
  let regional: StaticBuild['regional'];
  if (rv) {
    const rvData = readTrips(rv, rvDates, parentOf);
    const tiles = new Map<string, RegionalTile>();
    const tripTiles: Record<string, string[]> = {};
    const counts: Record<string, number[]> = {};
    const lines: Record<string, Set<string>> = {};
    for (const [tripId, trip] of rvData.trips) {
      const list = rvData.stopTimes.get(tripId);
      if (!list || list.length < 2) continue;
      const merged = mergeStops(list);
      const route = rvData.routes.get(trip.route) ?? { name: '', agency: '' };
      const s = merged.map((x) => station(x.stop));
      const keys = [...new Set(s.map((i) => tileKey(stations[i].lat, stations[i].lon)))];
      tripTiles[tripId] = keys;
      (lines[lineKey(route.name || 'Zug')] ??= new Set()).add(keys[0]);
      const seqs = merged.map((x) => x.seq);
      const base: Omit<RegionalTrip, 'op'> = {
        id: tripId,
        line: route.name || 'Zug',
        stops: s,
        times: merged.flatMap((x) => [x.arr, x.dep]),
        ...(seqs.every((q, i) => q === i) ? {} : { seqs }),
      };
      rvDates.forEach((date, di) => {
        if (!(trip.mask & (1 << di))) return;
        s.forEach((i) => (stations[i].w! += 1 / rvDates.length));
        for (const key of keys) {
          const k = `${date}/${key}`;
          let tile = tiles.get(k);
          if (!tile) tiles.set(k, (tile = { version, date, tile: key, ops: [], trips: [] }));
          let op = tile.ops.indexOf(route.agency);
          if (op < 0) op = tile.ops.push(route.agency) - 1;
          tile.trips.push({ ...base, op });
          (counts[key] ??= rvDates.map(() => 0))[di]++;
        }
      });
    }
    rvData.stopTimes.clear();
    const lineTiles = Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, [...v]]));
    regional = { index: { version, dates: rvDates, tiles: counts, lines: lineTiles }, tiles, tripTiles };
  }

  // w = Zughalte pro Tag (alle Züge); bedient ist bedient, auch mit einem Halt pro Woche
  for (const st of stations) st.w = st.w! > 0 ? Math.max(1, Math.round(st.w!)) : 0;

  return {
    timetable: { generatedAt: version, source: 'gtfs.de (DELFI e.V., CC BY 4.0)', dates: fvDates, routes: routeNames, stations, trips: fvTrips, version },
    regional,
  };
}
