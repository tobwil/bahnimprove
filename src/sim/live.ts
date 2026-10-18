import { PUNCTUAL_LIMIT } from './analysis.ts';
import { inGermany, type DayModel } from './model.ts';
import { counts } from './real.ts';
import type { Incident, SimResult } from './types.ts';

export interface TrainState {
  trip: number;
  /** Position als Bruchteil zwischen Halt `stop` und `stop + 1`; bei Halt am Bahnhof ist `progress` 0 und `atStation` true. */
  stop: number;
  progress: number;
  atStation: boolean;
  /** Aktuelle Verspätung in Minuten. */
  delay: number;
  /** false = keine Echtzeitdaten für diese Fahrt (Position nach Fahrplan). */
  known: boolean;
}

/** Zustand eines Zugs zum Zeitpunkt `t` (Minuten ab Mitternacht des Verkehrstags) oder null, wenn nicht unterwegs. */
export function trainAt(m: DayModel, r: SimResult, trip: number, t: number): TrainState | null {
  const T = m.trips[trip];
  const R = r.trips[trip];
  const n = T.stops.length;
  if (R.canceled || t < R.dep[0] - 2 || t > R.arr[n - 1] + 1) return null;
  const known = R.known !== false;
  // Binärsuche nach dem letzten Halt mit Ankunft ≤ t
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (R.arr[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  if (i === n - 1 || t < R.dep[i]) {
    return { trip, stop: i, progress: 0, atStation: true, delay: Math.max(0, i === 0 ? R.dep[0] - T.schedDep[0] : R.arr[i] - T.schedArr[i]), known };
  }
  const span = R.arr[i + 1] - R.dep[i];
  const progress = span > 0 ? (t - R.dep[i]) / span : 1;
  // Verspätung während der Fahrt: linear zwischen Abfahrts- und Ankunftsverspätung.
  const d0 = R.dep[i] - T.schedDep[i];
  const d1 = R.arr[i + 1] - T.schedArr[i + 1];
  return { trip, stop: i, progress, atStation: false, delay: Math.max(0, d0 + (d1 - d0) * progress), known };
}

export function trainsAt(m: DayModel, r: SimResult, t: number): TrainState[] {
  const out: TrainState[] = [];
  for (let i = 0; i < m.trips.length; i++) {
    const s = trainAt(m, r, i, t);
    if (s) out.push(s);
  }
  return out;
}

export function activeIncidents(m: DayModel, t: number): Incident[] {
  return m.incidents.filter((i) => i.start <= t && t < i.end);
}

export interface LiveHotspot {
  station: number;
  minutes: number;
  trains: number;
}

/** Wo wächst die Verspätung gerade? Zuwachs je Bahnhof aus Fahrten und Halten der letzten `window` Minuten. */
export function hotspotsAt(m: DayModel, r: SimResult, t: number, window = 60): LiveHotspot[] {
  const acc = new Map<number, { minutes: number; trains: Set<number> }>();
  const add = (station: number, trip: number, g: number) => {
    if (g < 1) return;
    const e = acc.get(station) ?? { minutes: 0, trains: new Set<number>() };
    e.minutes += g;
    e.trains.add(trip);
    acc.set(station, e);
  };
  for (const T of m.trips) {
    const R = r.trips[T.id];
    if (!counts(R) || R.dep[0] > t || R.arr[T.stops.length - 1] < t - window) continue;
    for (let i = 0; i + 1 < T.stops.length; i++) {
      const a = R.arr[i + 1];
      if (a > t) break;
      if (a < t - window) continue;
      add(T.stops[i + 1], T.id, a - T.schedArr[i + 1] - (R.dep[i] - T.schedDep[i]));
      if (i > 0 && R.dep[i] >= t - window) add(T.stops[i], T.id, R.dep[i] - T.schedDep[i] - (R.arr[i] - T.schedArr[i]));
    }
  }
  return [...acc.entries()]
    .map(([station, e]) => ({ station, minutes: e.minutes, trains: e.trains.size }))
    .filter((h) => h.minutes >= 3)
    .sort((a, b) => b.minutes - a.minutes);
}

/** Kennzahlen aller bis `t` erfolgten Ankünfte – vorab sortiert für schnelle Abfragen. */
export class ArrivalIndex {
  private times: Float64Array;
  private punctualPrefix: Uint32Array;
  private delayPrefix: Float64Array;

  constructor(m: DayModel, r: SimResult) {
    const list: { t: number; d: number }[] = [];
    for (const T of m.trips) {
      const R = r.trips[T.id];
      if (!counts(R)) continue;
      for (let i = 1; i < T.stops.length; i++) {
        if (!inGermany(m.stations[T.stops[i]])) continue;
        list.push({ t: R.arr[i], d: Math.max(0, R.arr[i] - T.schedArr[i]) });
      }
    }
    list.sort((a, b) => a.t - b.t);
    this.times = Float64Array.from(list, (x) => x.t);
    this.punctualPrefix = new Uint32Array(list.length + 1);
    this.delayPrefix = new Float64Array(list.length + 1);
    list.forEach((x, i) => {
      this.punctualPrefix[i + 1] = this.punctualPrefix[i] + (x.d < PUNCTUAL_LIMIT ? 1 : 0);
      this.delayPrefix[i + 1] = this.delayPrefix[i] + x.d;
    });
  }

  until(t: number) {
    let lo = 0, hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return {
      arrivals: lo,
      punctuality: lo ? this.punctualPrefix[lo] / lo : 1,
      avgDelay: lo ? this.delayPrefix[lo] / lo : 0,
    };
  }
}

/** Ankünfte und pünktliche Ankünfte je Stunde des Verkehrstags (03:00 bis 03:00). */
export function hourlyPunctuality(m: DayModel, r: SimResult): { arrivals: number; punctual: number }[] {
  const bins = Array.from({ length: 24 }, () => ({ arrivals: 0, punctual: 0 }));
  for (const T of m.trips) {
    const R = r.trips[T.id];
    if (!counts(R)) continue;
    for (let i = 1; i < T.stops.length; i++) {
      if (!inGermany(m.stations[T.stops[i]])) continue;
      const h = Math.floor(R.arr[i] / 60) - 3;
      if (h < 0 || h > 23) continue;
      bins[h].arrivals++;
      if (R.arr[i] - T.schedArr[i] < PUNCTUAL_LIMIT) bins[h].punctual++;
    }
  }
  return bins;
}
