/**
 * Lädt den freien Fernverkehrs-GTFS-Feed von gtfs.de (Daten: DELFI e.V., CC BY 4.0)
 * und erzeugt daraus eine kompakte Fahrplan-Datei für das Frontend.
 *
 *   npm run data            # lädt latest.zip neu
 *   GTFS_DIR=/pfad npm run data   # nutzt einen bereits entpackten Feed
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Timetable, TimetableStation, TimetableTrip } from '../src/sim/types.ts';

const FEED_URL = 'https://download.gtfs.de/germany/fv_free/latest.zip';
/** Gestern (für den Tagesbericht) plus zwei Wochen voraus. */
const DAYS = 15;
const OUT = 'public/data/timetable.json';

function loadFeedDir(): string {
  if (process.env.GTFS_DIR) return process.env.GTFS_DIR;
  const dir = '.cache/gtfs-fv';
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, 'latest.zip');
  console.log(`Lade ${FEED_URL} …`);
  execFileSync('curl', ['-sSfL', '-o', zip, FEED_URL], { stdio: 'inherit' });
  execFileSync('unzip', ['-o', '-q', zip, '-d', dir], { stdio: 'inherit' });
  return dir;
}

/** Minimaler CSV-Parser mit Unterstützung für Anführungszeichen. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift()!.map((h) => h.replace(/^﻿/, ''));
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const read = (dir: string, file: string) => parseCsv(readFileSync(join(dir, file), 'utf8'));

function berlinToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts.replaceAll('-', '');
}

function addDays(yyyymmdd: string, n: number): string {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

const weekdayKey = (yyyymmdd: string) =>
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
    new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8))).getUTCDay()
  ];

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
    else if (/^(Hauptbahnhof|Hbf|Bahnhof|Bf)\b/.test(rest)) n = `${city} ${rest}`;
    else n = city;
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

const toMinutes = (hms: string) => {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 60 + m + Math.round((s || 0) / 60);
};

function main() {
  const dir = loadFeedDir();
  const start = process.env.START_DATE ?? addDays(berlinToday(), -1);
  const dates = Array.from({ length: DAYS }, (_, i) => addDays(start, i));

  // Verkehrstage je service_id als Bitmaske über `dates`.
  const serviceMask = new Map<string, number>();
  if (existsSync(join(dir, 'calendar.txt'))) {
    for (const c of read(dir, 'calendar.txt')) {
      let mask = 0;
      dates.forEach((d, i) => {
        if (d >= c.start_date && d <= c.end_date && c[weekdayKey(d)] === '1') mask |= 1 << i;
      });
      serviceMask.set(c.service_id, mask);
    }
  }
  for (const cd of read(dir, 'calendar_dates.txt')) {
    const i = dates.indexOf(cd.date);
    if (i < 0) continue;
    const mask = serviceMask.get(cd.service_id) ?? 0;
    serviceMask.set(cd.service_id, cd.exception_type === '1' ? mask | (1 << i) : mask & ~(1 << i));
  }

  const agencies = new Map(read(dir, 'agency.txt').map((a) => [a.agency_id, a.agency_name]));
  const routes = new Map(read(dir, 'routes.txt').map((r) => [r.route_id, { name: r.route_short_name || r.route_long_name, agency: agencies.get(r.agency_id) ?? '' }]));

  const rawStops = read(dir, 'stops.txt');
  const stopById = new Map(rawStops.map((s) => [s.stop_id, s]));
  const parentOf = (id: string) => {
    const s = stopById.get(id);
    return s?.parent_station ? s.parent_station : id;
  };

  const trips = new Map<string, { route: string; mask: number }>();
  for (const t of read(dir, 'trips.txt')) {
    const mask = serviceMask.get(t.service_id) ?? 0;
    if (mask) trips.set(t.trip_id, { route: t.route_id, mask });
  }

  const stopTimes = new Map<string, { seq: number; stop: string; arr: number; dep: number }[]>();
  for (const st of read(dir, 'stop_times.txt')) {
    if (!trips.has(st.trip_id)) continue;
    let list = stopTimes.get(st.trip_id);
    if (!list) stopTimes.set(st.trip_id, (list = []));
    list.push({ seq: +st.stop_sequence, stop: parentOf(st.stop_id), arr: toMinutes(st.arrival_time || st.departure_time), dep: toMinutes(st.departure_time || st.arrival_time) });
  }

  const stationIndex = new Map<string, number>();
  const stations: TimetableStation[] = [];
  const routeNames: string[] = [];
  const routeIndex = new Map<string, number>();
  const outTrips: TimetableTrip[] = [];

  for (const [tripId, trip] of trips) {
    const list = stopTimes.get(tripId);
    if (!list || list.length < 2) continue;
    list.sort((a, b) => a.seq - b.seq);
    // Doppelte aufeinanderfolgende Halte (Gleiswechsel im selben Bahnhof) zusammenfassen.
    const merged = list.filter((s, i) => i === 0 || s.stop !== list[i - 1].stop);
    const route = routes.get(trip.route) ?? { name: '?', agency: '' };
    const rKey = `${route.name}|${route.agency}`;
    if (!routeIndex.has(rKey)) { routeIndex.set(rKey, routeNames.length); routeNames.push(route.name); }
    const s: number[] = [];
    const t: number[] = [];
    for (const stop of merged) {
      let idx = stationIndex.get(stop.stop);
      if (idx === undefined) {
        const raw = stopById.get(stop.stop)!;
        idx = stations.length;
        stationIndex.set(stop.stop, idx);
        const lat = +(+raw.stop_lat).toFixed(5);
        const lon = +(+raw.stop_lon).toFixed(5);
        stations.push({ name: cleanName(raw.stop_name, lat, lon), lat, lon, weight: 0 });
      }
      stations[idx].weight++;
      s.push(idx);
      t.push(stop.arr, stop.dep);
    }
    outTrips.push({ route: routeIndex.get(rKey)!, operator: route.agency, days: trip.mask, stops: s, times: t });
  }

  outTrips.sort((a, b) => a.times[1] - b.times[1]);
  const timetable: Timetable = {
    generatedAt: new Date().toISOString(),
    source: 'gtfs.de Fernverkehr (DELFI e.V., CC BY 4.0)',
    dates,
    routes: routeNames,
    stations,
    trips: outTrips,
  };
  mkdirSync('public/data', { recursive: true });
  writeFileSync(OUT, JSON.stringify(timetable));
  const perDay = dates.map((d, i) => `${d}:${outTrips.filter((t) => t.days & (1 << i)).length}`).join(' ');
  console.log(`${OUT}: ${stations.length} Bahnhöfe, ${outTrips.length} Fahrten (${perDay})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
