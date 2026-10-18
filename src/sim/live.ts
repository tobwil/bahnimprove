import { PUNCTUAL_LIMIT } from './analysis.ts';
import { inGermany, type DayModel } from './model.ts';
import type { Incident, SimResult } from './types.ts';

export interface TrainState {
  trip: number;
  /** Position als Bruchteil zwischen Halt `stop` und `stop + 1`; bei Halt am Bahnhof ist `progress` 0 und `atStation` true. */
  stop: number;
  progress: number;
  atStation: boolean;
  /** Aktuelle Verspätung in Minuten. */
  delay: number;
}

/** Zustand eines Zugs zum Zeitpunkt `t` (Minuten ab Mitternacht des Verkehrstags) oder null, wenn nicht unterwegs. */
export function trainAt(m: DayModel, r: SimResult, trip: number, t: number): TrainState | null {
  const T = m.trips[trip];
  const R = r.trips[trip];
  const n = T.stops.length;
  if (t < R.dep[0] - 2 || t > R.arr[n - 1] + 1) return null;
  // Binärsuche nach dem letzten Halt mit Ankunft ≤ t
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (R.arr[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  if (i === n - 1 || t < R.dep[i]) {
    return { trip, stop: i, progress: 0, atStation: true, delay: Math.max(0, (i === 0 ? R.dep[0] - T.schedDep[0] : R.arr[i] - T.schedArr[i])) };
  }
  const span = R.arr[i + 1] - R.dep[i];
  const progress = span > 0 ? (t - R.dep[i]) / span : 1;
  // Verspätung während der Fahrt: linear zwischen Abfahrts- und Ankunftsverspätung.
  const d0 = R.dep[i] - T.schedDep[i];
  const d1 = R.arr[i + 1] - T.schedArr[i + 1];
  return { trip, stop: i, progress, atStation: false, delay: Math.max(0, d0 + (d1 - d0) * progress) };
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

/** Kennzahlen aller bis `t` erfolgten Ankünfte – vorab sortiert für schnelle Abfragen. */
export class ArrivalIndex {
  private times: Float64Array;
  private punctualPrefix: Uint32Array;
  private delayPrefix: Float64Array;

  constructor(m: DayModel, r: SimResult) {
    const list: { t: number; d: number }[] = [];
    for (const T of m.trips) {
      const R = r.trips[T.id];
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
