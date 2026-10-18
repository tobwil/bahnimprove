import { hashString, rng, type Rng } from './rng.ts';
import type { Connection, Incident, IncidentKind, Timetable, TimetableStation, Trip } from './types.ts';

/** Alles, was eine Simulation eines Verkehrstags braucht. Zufallswerte sind hier fest gewürfelt,
 *  damit jede Gegenrechnung (andere Disposition) dieselbe Ausgangslage hat. */
export interface DayModel {
  date: string;
  /** Verkehrstag, dessen Fahrplan tatsächlich verwendet wurde (bei Rückfall auf gleichen Wochentag). */
  timetableDate: string;
  stations: TimetableStation[];
  trips: Trip[];
  incidents: Incident[];
  /** Streckenstörungen je gerichteter Kante (edgeKey). */
  edgeIncidents: Map<number, Incident[]>;
  /** Zugbezogene Störungen je (trip, halt). */
  stopIncidents: Map<number, Incident[]>;
  connections: Connection[];
  /** Anschlüsse je abfahrendem Zug und Halt (stopKey). */
  connectionsByDeparture: Map<number, number[]>;
  originDelay: Float64Array;
  /** Zusätzliche Fahrzeit je Fahrt und Abschnitt (betriebliche Gründe, Mischverkehr …). */
  opsNoise: Float64Array[];
  /** Haltezeitüberschreitung bei vollen, verspäteten Zügen. */
  dwellNoise: Float64Array[];
  passengers: Float64Array;
}

export const edgeKey = (from: number, to: number) => from * 100000 + to;
export const stopKey = (trip: number, stop: number) => trip * 512 + stop;

const KM_PER_DEG_LAT = 111.3;
const KM_PER_DEG_LON = 71.5; // cos(50°) · 111,3

/** Grob Deutschland – Störungen erzeugen wir nur im deutschen Netz. */
export const inGermany = (s: { lat: number; lon: number }) => s.lat > 47.3 && s.lat < 55.0 && s.lon > 5.9 && s.lon < 15.0;

export function categoryOf(line: string): string {
  return line.split(' ')[0];
}

const PAX: Record<string, number> = { ICE: 430, IC: 300, EC: 280, ECE: 300, RJ: 260, RJX: 260, NJ: 180, EN: 180, TGV: 420, FLX: 250 };
export const passengersOf = (category: string) => PAX[category] ?? 250;

export function resolveTimetableDate(tt: Timetable, date: string): string {
  if (tt.dates.includes(date)) return date;
  const weekday = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay();
  return tt.dates.find((d) => weekday(d) === weekday(date)) ?? tt.dates[0];
}

export function tripsForDate(tt: Timetable, date: string): Trip[] {
  const bit = 1 << tt.dates.indexOf(date);
  const trips: Trip[] = [];
  for (const t of tt.trips) {
    if (!(t.days & bit)) continue;
    const line = tt.routes[t.route];
    trips.push({
      id: trips.length,
      line,
      category: categoryOf(line),
      operator: t.operator,
      stops: t.stops,
      schedArr: t.stops.map((_, i) => t.times[i * 2]),
      schedDep: t.stops.map((_, i) => t.times[i * 2 + 1]),
    });
  }
  return trips;
}

function distToSegmentKm(p: { lat: number; lon: number }, a: TimetableStation, b: TimetableStation): number {
  const ax = a.lon * KM_PER_DEG_LON, ay = a.lat * KM_PER_DEG_LAT;
  const bx = b.lon * KM_PER_DEG_LON, by = b.lat * KM_PER_DEG_LAT;
  const px = p.lon * KM_PER_DEG_LON, py = p.lat * KM_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

interface IncidentSpec {
  kind: IncidentKind;
  count: [number, number];
  duration: [number, number];
  extra: [number, number];
  blocking: boolean;
  headway?: number;
  allDay?: boolean;
}

const LINE_INCIDENTS: IncidentSpec[] = [
  { kind: 'oberleitung', count: [0, 2], duration: [50, 140], extra: [0, 0], blocking: true },
  { kind: 'personen', count: [2, 4], duration: [15, 45], extra: [0, 0], blocking: true },
  { kind: 'signal', count: [3, 6], duration: [30, 120], extra: [3, 8], blocking: false },
  { kind: 'weiche', count: [2, 4], duration: [30, 100], extra: [2, 5], blocking: false, headway: 6 },
  { kind: 'bau', count: [9, 14], duration: [0, 0], extra: [2, 6], blocking: false, allDay: true },
];

function generateIncidents(r: Rng, stations: TimetableStation[], trips: Trip[]): Incident[] {
  // Abschnitte im deutschen Netz, gewichtet nach Verkehr (viel Verkehr → mehr Auswirkungen).
  const usage = new Map<number, { from: number; to: number; n: number }>();
  for (const t of trips) {
    for (let i = 0; i + 1 < t.stops.length; i++) {
      const a = Math.min(t.stops[i], t.stops[i + 1]);
      const b = Math.max(t.stops[i], t.stops[i + 1]);
      if (!inGermany(stations[a]) || !inGermany(stations[b])) continue;
      const k = edgeKey(a, b);
      const u = usage.get(k);
      if (u) u.n++;
      else usage.set(k, { from: a, to: b, n: 1 });
    }
  }
  const edges = [...usage.values()];
  const incidents: Incident[] = [];
  for (const spec of LINE_INCIDENTS) {
    const n = r.int(spec.count[0], spec.count[1]);
    for (let i = 0; i < n; i++) {
      const e = r.pickWeighted(edges, (x) => x.n);
      const u = r.range(0.2, 0.8);
      const a = stations[e.from], b = stations[e.to];
      const start = spec.allDay ? 0 : Math.round(r.range(5 * 60, 22 * 60));
      incidents.push({
        id: incidents.length,
        kind: spec.kind,
        from: e.from,
        to: e.to,
        lat: a.lat + (b.lat - a.lat) * u,
        lon: a.lon + (b.lon - a.lon) * u,
        start,
        end: spec.allDay ? 30 * 60 : start + Math.round(r.range(spec.duration[0], spec.duration[1])),
        extra: Math.round(r.range(spec.extra[0], spec.extra[1])),
        blocking: spec.blocking,
        headway: spec.headway,
      });
    }
  }
  // Zugbezogene Störungen: Notarzteinsatz am Zug, Reparatur/Türstörung.
  const dayTrips = trips.filter((t) => t.stops.length > 3);
  for (const [kind, count, min, max] of [['notarzt', r.int(1, 3), 15, 35], ['fahrzeug', r.int(3, 6), 8, 25]] as const) {
    for (let i = 0; i < count && dayTrips.length; i++) {
      const t = dayTrips[r.int(0, dayTrips.length - 1)];
      const stop = r.int(1, t.stops.length - 2);
      const s = stations[t.stops[stop]];
      const extra = Math.round(r.range(min, max));
      incidents.push({
        id: incidents.length,
        kind,
        from: t.stops[stop],
        to: t.stops[stop],
        lat: s.lat,
        lon: s.lon,
        start: t.schedArr[stop],
        end: t.schedDep[stop] + extra,
        extra,
        blocking: false,
        trip: t.id,
        stop,
      });
    }
  }
  return incidents;
}

/** Ordnet Streckenstörungen allen Kanten zu, die geografisch durch den Störungsort laufen
 *  (Kanten sind Halt-zu-Halt-Verbindungen, ein durchfahrender ICE nutzt dieselbe Strecke). */
function indexEdgeIncidents(stations: TimetableStation[], trips: Trip[], incidents: Incident[]) {
  const edges = new Map<number, [number, number]>();
  for (const t of trips) for (let i = 0; i + 1 < t.stops.length; i++) edges.set(edgeKey(t.stops[i], t.stops[i + 1]), [t.stops[i], t.stops[i + 1]]);
  const byEdge = new Map<number, Incident[]>();
  for (const inc of incidents) {
    if (inc.trip !== undefined) continue;
    for (const [k, [a, b]] of edges) {
      if (distToSegmentKm(inc, stations[a], stations[b]) > 4) continue;
      let list = byEdge.get(k);
      if (!list) byEdge.set(k, (list = []));
      list.push(inc);
    }
  }
  return byEdge;
}

const HUB_WEIGHT = 250;
const MIN_TRANSFER_WINDOW = 4;
const MAX_TRANSFER_WINDOW = 20;

/** Ohne Alternative am selben Tag: pauschal 4 Stunden (Hotel, Taxi, nächster Morgen). */
export const MAX_MISS_PENALTY = 240;

/** Zusatzzeit am nächsten großen Halt von B, wenn Umsteiger B verpassen und die nächste passende Fahrt nehmen. */
function missPenaltyFor(stations: TimetableStation[], trips: Trip[], deps: { trip: number; stop: number }[], B: Trip, stop: number): number {
  let target = stop + 1;
  for (let k = stop + 1; k < B.stops.length; k++) {
    if (stations[B.stops[k]].weight >= HUB_WEIGHT) { target = k; break; }
  }
  const targetStation = B.stops[target];
  let best = Infinity;
  for (const o of deps) {
    const O = trips[o.trip];
    if (O.id === B.id || O.schedDep[o.stop] <= B.schedDep[stop]) continue;
    for (let k = o.stop + 1; k < O.stops.length; k++) {
      if (O.stops[k] === targetStation) { best = Math.min(best, O.schedArr[k]); break; }
    }
  }
  if (!Number.isFinite(best)) return MAX_MISS_PENALTY;
  return Math.min(MAX_MISS_PENALTY - 1, Math.max(10, best - B.schedArr[target]));
}

function findConnections(r: Rng, stations: TimetableStation[], trips: Trip[]): Connection[] {
  const arrivals = new Map<number, { trip: number; stop: number }[]>();
  const departures = new Map<number, { trip: number; stop: number }[]>();
  for (const t of trips) {
    t.stops.forEach((s, i) => {
      if (stations[s].weight < HUB_WEIGHT) return;
      if (i > 0) (arrivals.get(s) ?? arrivals.set(s, []).get(s)!).push({ trip: t.id, stop: i });
      if (i < t.stops.length - 1) (departures.get(s) ?? departures.set(s, []).get(s)!).push({ trip: t.id, stop: i });
    });
  }
  const connections: Connection[] = [];
  for (const [station, deps] of departures) {
    const arrs = arrivals.get(station) ?? [];
    for (const d of deps) {
      const B = trips[d.trip];
      const next = B.stops[d.stop + 1];
      let missPenalty: number | undefined;
      for (const a of arrs) {
        if (a.trip === d.trip) continue;
        const A = trips[a.trip];
        if (A.line === B.line) continue;
        const window = B.schedDep[d.stop] - A.schedArr[a.stop];
        if (window < MIN_TRANSFER_WINDOW || window > MAX_TRANSFER_WINDOW) continue;
        // Kein Anschluss, wenn A selbst dorthin weiterfährt oder B dorthin zurückfährt, wo A herkommt.
        if (A.stops[a.stop + 1] === next || A.stops[a.stop - 1] === next) continue;
        missPenalty ??= missPenaltyFor(stations, trips, deps, B, d.stop);
        const size = Math.min(stations[station].weight, 800) / 800;
        connections.push({
          feeder: a.trip,
          feederStop: a.stop,
          departing: d.trip,
          departingStop: d.stop,
          station,
          passengers: Math.round(r.range(6, 18) + 22 * size),
          missPenalty,
        });
      }
    }
  }
  return connections;
}

export function buildDayModel(tt: Timetable, date: string): DayModel {
  const timetableDate = resolveTimetableDate(tt, date);
  const trips = tripsForDate(tt, timetableDate);
  const stations = tt.stations;
  const r = rng(hashString(`bahnimprove:${date}`));
  const incidents = generateIncidents(r, stations, trips);
  const edgeIncidents = indexEdgeIncidents(stations, trips, incidents);
  const stopIncidents = new Map<number, Incident[]>();
  for (const inc of incidents) {
    if (inc.trip === undefined) continue;
    const k = stopKey(inc.trip, inc.stop!);
    (stopIncidents.get(k) ?? stopIncidents.set(k, []).get(k)!).push(inc);
  }
  const connections = findConnections(r, stations, trips);
  const connectionsByDeparture = new Map<number, number[]>();
  connections.forEach((c, i) => {
    const k = stopKey(c.departing, c.departingStop);
    (connectionsByDeparture.get(k) ?? connectionsByDeparture.set(k, []).get(k)!).push(i);
  });

  const originDelay = new Float64Array(trips.length);
  const opsNoise: Float64Array[] = [];
  const dwellNoise: Float64Array[] = [];
  const passengers = new Float64Array(trips.length);
  for (const t of trips) {
    if (r.chance(0.3)) originDelay[t.id] = Math.round(1 + r.exp(5));
    const ops = new Float64Array(t.stops.length);
    const dwell = new Float64Array(t.stops.length);
    for (let i = 0; i < t.stops.length; i++) {
      ops[i] = r.chance(0.22) ? 1 + r.exp(3) : r.range(0, 0.5);
      const big = stations[t.stops[i]].weight > 300;
      dwell[i] = big && r.chance(0.35) ? r.range(0.5, 2.5) : 0;
    }
    opsNoise.push(ops);
    dwellNoise.push(dwell);
    passengers[t.id] = passengersOf(t.category);
  }

  return { date, timetableDate, stations, trips, incidents, edgeIncidents, stopIncidents, connections, connectionsByDeparture, originDelay, opsNoise, dwellNoise, passengers };
}
