import type { RealtimeDay } from '../realtime/types.ts';
import { MIN_TRANSFER } from './engine.ts';
import type { DayModel } from './model.ts';
import type { SimResult, TripResult } from './types.ts';

export interface ObservedStats {
  known: number;
  unknown: number;
  canceled: number;
  feedTime: number;
}

/**
 * Ist-Zeiten aus Echtzeitdaten. Halte ohne eigene Meldung übernehmen die zuletzt gemeldete
 * Verspätung (GTFS-Realtime-Regel); Fahrten ohne Daten behalten ihre Sollzeiten und sind `known: false`.
 */
export function observedResult(m: DayModel, rt: RealtimeDay): { result: SimResult; stats: ObservedStats } {
  const stats: ObservedStats = { known: 0, unknown: 0, canceled: 0, feedTime: rt.feedTime };
  const trips: TripResult[] = m.trips.map((T) => {
    const n = T.stops.length;
    const data = rt.trips[T.gtfsId];
    const causes = T.stops.map(() => []);
    if (!data || !data.u.length) {
      stats.unknown++;
      return { arr: [...T.schedArr], dep: [...T.schedDep], causes, known: false };
    }
    if (data.canceled) {
      stats.canceled++;
      return { arr: [...T.schedArr], dep: [...T.schedDep], causes, known: true, canceled: true };
    }
    stats.known++;
    const arrD: (number | null)[] = new Array(n).fill(null);
    const depD: (number | null)[] = new Array(n).fill(null);
    for (const [seq, a, d] of data.u) {
      // Halt mit der größten stop_sequence ≤ seq (zusammengelegte Doppelhalte)
      let k = -1;
      for (let i = 0; i < n && T.seqs[i] <= seq; i++) k = i;
      if (k < 0) continue;
      if (a !== null) arrD[k] = a;
      if (d !== null) depD[k] = d;
    }
    const firstKnown = [...arrD, ...depD].find((x) => x !== null) ?? 0;
    let cur = Math.max(0, depD[0] ?? firstKnown);
    const arr = new Array<number>(n);
    const dep = new Array<number>(n);
    arr[0] = T.schedArr[0];
    dep[0] = T.schedDep[0] + cur;
    for (let i = 1; i < n; i++) {
      const ad = arrD[i] ?? cur;
      arr[i] = Math.max(T.schedArr[i] + ad, dep[i - 1] + 0.5);
      if (i === n - 1) {
        dep[i] = arr[i];
        break;
      }
      // Ohne Meldung läuft die Verspätung unverändert weiter (GTFS-Realtime-Regel).
      const dd = depD[i] ?? arr[i] - T.schedArr[i];
      dep[i] = Math.max(arr[i], T.schedDep[i] + dd);
      cur = dep[i] - T.schedDep[i];
    }
    return { arr, dep, causes, known: true };
  });

  const connectionOutcome = m.connections.map((c) => {
    const A = trips[c.feeder], B = trips[c.departing];
    if (A.known === false || B.known === false || A.canceled || B.canceled) return 'kept' as const;
    return A.arr[c.feederStop] + MIN_TRANSFER > B.dep[c.departingStop] + 1e-6 ? ('missed' as const) : ('kept' as const);
  });
  return { result: { trips, connectionOutcome, connectionWait: m.connections.map(() => 0) }, stats };
}

/** Zählt diese Fahrt in Kennzahlen? (Simulation: immer; Echtzeit: nur mit Daten und ohne Ausfall) */
export const counts = (t: TripResult) => t.known !== false && !t.canceled;

/**
 * Modell, das den echten Tag nachspielt: Die beobachteten Verspätungszuwächse werden als
 * Startverspätung, Fahrzeit- und Haltezeitabweichungen je Abschnitt eingespeist.
 * Damit lassen sich andere Entscheidungen gegenrechnen.
 */
export function calibratedModel(m: DayModel, observed: SimResult): DayModel {
  const originDelay = new Float64Array(m.trips.length);
  const opsNoise: Float64Array[] = [];
  const dwellNoise: Float64Array[] = [];
  const fixedDwell: Float64Array[] = [];
  const skip = new Uint8Array(m.trips.length);
  for (const T of m.trips) {
    const n = T.stops.length;
    const R = observed.trips[T.id];
    const ops = new Float64Array(n);
    const fixed = new Float64Array(n);
    if (R.canceled) skip[T.id] = 1;
    else if (R.known !== false) {
      originDelay[T.id] = Math.max(0, R.dep[0] - T.schedDep[0]);
      for (let i = 0; i + 1 < n; i++) {
        const sched = T.schedArr[i + 1] - T.schedDep[i];
        ops[i] = Math.max(-0.15 * sched, R.arr[i + 1] - R.dep[i] - sched);
      }
      for (let i = 1; i + 1 < n; i++) {
        const ready = Math.max(T.schedDep[i], R.arr[i] + Math.min(T.schedDep[i] - T.schedArr[i], 1));
        fixed[i] = Math.max(0, R.dep[i] - ready);
      }
    }
    opsNoise.push(ops);
    dwellNoise.push(new Float64Array(n));
    fixedDwell.push(fixed);
  }
  return {
    ...m,
    incidents: [],
    edgeIncidents: new Map(),
    stopIncidents: new Map(),
    originDelay,
    opsNoise,
    dwellNoise,
    fixedDwell,
    skip,
    reserve: 0,
  };
}
