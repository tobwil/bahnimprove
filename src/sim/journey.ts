/**
 * Verbindungssuche im Fernverkehr (direkt oder mit einem Umstieg) mit Live-Prognose:
 * Wie wahrscheinlich klappt jeder Umstieg, und welche Verbindung kommt voraussichtlich zuerst an?
 */
import type { DayModel } from './model.ts';
import type { SimResult } from './types.ts';

export interface Leg {
  trip: number;
  from: number;
  to: number;
}

export interface TransferRisk {
  station: number;
  /** Geplanter Übergang in Minuten */
  planned: number;
  /** Übergang laut aktueller Prognose */
  predicted: number;
  /** Mindestumsteigezeit an diesem Bahnhof */
  needed: number;
  /** Wahrscheinlichkeit, dass der Umstieg klappt (0…1) */
  probability: number;
  /** Zubringer hat keine Echtzeitdaten – Schätzung unsicherer */
  uncertain: boolean;
}

export interface Journey {
  legs: Leg[];
  schedDep: number;
  schedArr: number;
  predDep: number;
  predArr: number;
  transfers: TransferRisk[];
  probability: number;
  /** Erwartete Ankunft unter Berücksichtigung, dass ein Umstieg platzen kann */
  expectedArr: number;
  canceled: boolean;
}

export interface JourneyResult {
  journeys: Journey[];
  /** Index der empfohlenen Verbindung */
  recommended: number;
}

/** Normalverteilung Φ(x) (Abramowitz/Stegun-Näherung). */
function phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Mindestumsteigezeit: große Knoten mit langen Wegen brauchen mehr. */
export const neededTransfer = (m: DayModel, station: number) => (m.stations[station].weight > 300 ? 6 : 4);

/**
 * Wahrscheinlichkeit, dass ein Umstieg klappt. Unsicherheit wächst mit der Zeit bis zur Ankunft des Zubringers
 * (Verspätungen wachsen im Mittel eher, als dass sie schrumpfen); ohne Echtzeitdaten deutlich unsicherer.
 */
export function transferProbability(buffer: number, needed: number, minutesUntilArrival: number, known: boolean): number {
  const ahead = Math.max(0, minutesUntilArrival);
  if (known && ahead <= 0.5) return buffer >= needed ? 1 : 0;
  const sigma = known ? Math.min(10, 1 + 0.08 * ahead) : 6;
  const drift = known ? Math.min(3, 0.03 * ahead) : 3;
  return phi((buffer - needed + 0.5 - drift) / sigma);
}

interface StopRef {
  trip: number;
  stop: number;
}

/** Index: welche Fahrten halten an welchem Bahnhof (einmal je Verkehrstag). */
const indexCache = new WeakMap<DayModel, Map<number, StopRef[]>>();
function stopsAt(m: DayModel): Map<number, StopRef[]> {
  let idx = indexCache.get(m);
  if (!idx) {
    idx = new Map();
    for (const T of m.trips) T.stops.forEach((s, i) => (idx!.get(s) ?? idx!.set(s, []).get(s)!).push({ trip: T.id, stop: i }));
    indexCache.set(m, idx);
  }
  return idx;
}

export function searchJourneys(m: DayModel, r: SimResult, from: number, to: number, after: number, now: number, opts: { window?: number; max?: number } = {}): JourneyResult {
  const window = opts.window ?? 240;
  const max = opts.max ?? 6;
  const idx = stopsAt(m);
  const toIndex = new Map<number, number>();
  for (const ref of idx.get(to) ?? []) toIndex.set(ref.trip, ref.stop);
  const found: Journey[] = [];

  const legsJourney = (legs: Leg[]): Journey | null => {
    const first = legs[0], last = legs[legs.length - 1];
    const T0 = m.trips[first.trip], TL = m.trips[last.trip];
    const R0 = r.trips[first.trip], RL = r.trips[last.trip];
    const transfers: TransferRisk[] = [];
    let probability = 1;
    for (let k = 0; k + 1 < legs.length; k++) {
      const A = legs[k], B = legs[k + 1];
      const TA = m.trips[A.trip], TB = m.trips[B.trip];
      const RA = r.trips[A.trip], RB = r.trips[B.trip];
      const station = TA.stops[A.to];
      const needed = neededTransfer(m, station);
      const planned = TB.schedDep[B.from] - TA.schedArr[A.to];
      const predicted = RB.dep[B.from] - RA.arr[A.to];
      const known = RA.known !== false;
      const p = transferProbability(predicted, needed, RA.arr[A.to] - now, known);
      transfers.push({ station, planned, predicted, needed, probability: p, uncertain: !known });
      probability *= p;
    }
    const canceled = legs.some((l) => r.trips[l.trip].canceled);
    return {
      legs,
      schedDep: T0.schedDep[first.from],
      schedArr: TL.schedArr[last.to],
      predDep: R0.dep[first.from],
      predArr: RL.arr[last.to],
      transfers,
      probability: canceled ? 0 : probability,
      expectedArr: 0,
      canceled,
    };
  };

  for (const a of idx.get(from) ?? []) {
    const TA = m.trips[a.trip];
    if (a.stop >= TA.stops.length - 1) continue;
    const dep = TA.schedDep[a.stop];
    if (dep < after - 1 || dep > after + window) continue;
    // Direkt
    const j = toIndex.get(a.trip);
    if (j !== undefined && j > a.stop) {
      found.push(legsJourney([{ trip: a.trip, from: a.stop, to: j }])!);
      continue;
    }
    // Ein Umstieg
    for (let k = a.stop + 1; k < TA.stops.length; k++) {
      const x = TA.stops[k];
      const arrX = TA.schedArr[k];
      const needed = neededTransfer(m, x);
      for (const b of idx.get(x) ?? []) {
        if (b.trip === a.trip) continue;
        const jb = toIndex.get(b.trip);
        if (jb === undefined || jb <= b.stop) continue;
        const TB = m.trips[b.trip];
        const buffer = TB.schedDep[b.stop] - arrX;
        if (buffer < needed || buffer > 90) continue;
        // Nicht zurückfahren, wo man herkam
        if (TB.stops.slice(b.stop + 1, jb + 1).some((s) => TA.stops.slice(a.stop, k).includes(s))) continue;
        found.push(legsJourney([{ trip: a.trip, from: a.stop, to: k }, { trip: b.trip, from: b.stop, to: jb }])!);
      }
    }
  }

  // Zwei Umstiege, nur wenn es kaum andere Verbindungen gibt (z. B. Kiel → Dresden)
  if (found.length < 3) {
    // Rückwärts: von welchen Bahnhöfen fährt ein Zug direkt zum Ziel?
    const feeders = new Map<number, { trip: number; stop: number; to: number }[]>();
    for (const [trip, j] of toIndex) {
      const T = m.trips[trip];
      for (let y = 0; y < j; y++) (feeders.get(T.stops[y]) ?? feeders.set(T.stops[y], []).get(T.stops[y])!).push({ trip, stop: y, to: j });
    }
    for (const a of idx.get(from) ?? []) {
      const TA = m.trips[a.trip];
      const dep = TA.schedDep[a.stop];
      if (a.stop >= TA.stops.length - 1 || dep < after - 1 || dep > after + window || toIndex.has(a.trip)) continue;
      for (let k = a.stop + 1; k < TA.stops.length; k++) {
        const x = TA.stops[k];
        const needX = neededTransfer(m, x);
        for (const b of idx.get(x) ?? []) {
          const TB = m.trips[b.trip];
          if (b.trip === a.trip || toIndex.has(b.trip)) continue;
          const bufX = TB.schedDep[b.stop] - TA.schedArr[k];
          if (bufX < needX || bufX > 60) continue;
          for (let y = b.stop + 1; y < TB.stops.length; y++) {
            const needY = neededTransfer(m, TB.stops[y]);
            for (const c of feeders.get(TB.stops[y]) ?? []) {
              if (c.trip === a.trip || c.trip === b.trip) continue;
              const bufY = m.trips[c.trip].schedDep[c.stop] - TB.schedArr[y];
              if (bufY < needY || bufY > 60) continue;
              found.push(legsJourney([{ trip: a.trip, from: a.stop, to: k }, { trip: b.trip, from: b.stop, to: y }, { trip: c.trip, from: c.stop, to: c.to }])!);
            }
          }
        }
      }
    }
  }

  // Pareto-Auswahl: nichts behalten, das später ankommt, obwohl es früher oder gleichzeitig abfährt (bei gleich vielen Umstiegen)
  found.sort((x, y) => x.schedDep - y.schedDep || x.schedArr - y.schedArr || x.legs.length - y.legs.length);
  const pareto = found.filter(
    (j) =>
      !found.some(
        (o) => o !== j && o.schedDep >= j.schedDep && o.schedArr <= j.schedArr && o.legs.length <= j.legs.length && (o.schedDep > j.schedDep || o.schedArr < j.schedArr || o.legs.length < j.legs.length),
      ),
  );
  // Gleiche Abfahrt und Ankunft nur einmal – die Variante mit dem sichersten Umstieg
  const best = new Map<string, Journey>();
  for (const j of pareto) {
    const key = `${j.schedDep}|${j.schedArr}|${j.legs.length}`;
    const o = best.get(key);
    if (!o || j.probability > o.probability) best.set(key, j);
  }
  const journeys = [...best.values()].sort((x, y) => x.schedDep - y.schedDep).slice(0, max);

  // Erwartete Ankunft: platzt ein Umstieg, bleibt die nächste spätere Verbindung
  journeys.forEach((j, i) => {
    const fallback = journeys.slice(i + 1).filter((o) => !o.canceled).map((o) => o.predArr);
    const next = fallback.length ? Math.min(...fallback) : j.predArr + 90;
    j.expectedArr = j.canceled ? Infinity : j.probability * j.predArr + (1 - j.probability) * Math.max(next, j.predArr);
  });
  let recommended = -1;
  journeys.forEach((j, i) => {
    if (j.predDep < now - 0.5 || j.canceled) return;
    if (recommended < 0 || j.expectedArr < journeys[recommended].expectedArr - 0.5) recommended = i;
  });
  return { journeys, recommended };
}
