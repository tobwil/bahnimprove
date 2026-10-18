import { defaultPolicy, simulate } from './engine.ts';
import { inGermany, type DayModel } from './model.ts';
import type { Cause, Incident, Policy, SimResult } from './types.ts';

/** DB-Definition: pünktlich = weniger als 6 Minuten Verspätung. */
export const PUNCTUAL_LIMIT = 6;

export interface Metrics {
  arrivals: number;
  punctual: number;
  punctuality: number;
  avgDelay: number;
  /** Geschätzte Fahrgast-Verspätungsminuten inkl. verpasster Anschlüsse. */
  passengerDelayMinutes: number;
  missedConnections: number;
  strandedPassengers: number;
  heldConnections: number;
  causeMinutes: Record<Cause['type'], number>;
}

export function metrics(m: DayModel, r: SimResult): Metrics {
  let arrivals = 0, punctual = 0, delaySum = 0, pdm = 0;
  const causeMinutes: Metrics['causeMinutes'] = { incident: 0, knockon: 0, connection: 0, yield: 0, origin: 0, dwell: 0, ops: 0 };
  for (const t of m.trips) {
    const R = r.trips[t.id];
    let tripDelay = 0;
    for (let i = 1; i < t.stops.length; i++) {
      const d = Math.max(0, R.arr[i] - t.schedArr[i]);
      if (inGermany(m.stations[t.stops[i]])) {
        arrivals++;
        if (d < PUNCTUAL_LIMIT) punctual++;
        delaySum += d;
      }
      tripDelay += d;
    }
    pdm += (m.passengers[t.id] * tripDelay) / (t.stops.length - 1);
    for (const cs of R.causes) for (const c of cs) causeMinutes[c.type] += c.minutes;
  }
  let missed = 0, stranded = 0, held = 0;
  r.connectionOutcome.forEach((o, i) => {
    const c = m.connections[i];
    if (o === 'missed') {
      missed++;
      stranded += c.passengers;
      pdm += c.passengers * c.missPenalty;
    } else if (o === 'held') held++;
  });
  return {
    arrivals,
    punctual,
    punctuality: arrivals ? punctual / arrivals : 1,
    avgDelay: arrivals ? delaySum / arrivals : 0,
    passengerDelayMinutes: pdm,
    missedConnections: missed,
    strandedPassengers: stranded,
    heldConnections: held,
    causeMinutes,
  };
}

export type SuggestionKind = 'hold' | 'release' | 'yield';

export interface Suggestion {
  kind: SuggestionKind;
  time: number;
  station: number;
  /** Hauptbeteiligte Fahrten: [Zug, der anders disponiert wird, betroffener Zug]. */
  trips: [number, number];
  connection?: number;
  /** Ersparnis in Fahrgast-Minuten (positiv = besser), einzeln gegengerechnet. */
  savedPassengerMinutes: number;
  /** Veränderung der Pünktlichkeit in Prozentpunkten. */
  punctualityDelta: number;
  /** Zusätzliche Minuten Wartezeit für den disponierten Zug. */
  cost: number;
}

export interface IncidentImpact {
  incident: Incident;
  /** Direkt verursachte Verspätungsminuten (ohne Folgeverspätungen). */
  directMinutes: number;
  trainsAffected: number;
}

export interface StationHotspot {
  station: number;
  /** Verspätungszuwachs an diesem Knoten (Summe über alle Züge). */
  minutesGained: number;
  trains: number;
}

/** Wonach der Leitstand optimiert: Fahrgastminuten oder Pünktlichkeitsquote (DB-Kennzahl). */
export type Objective = 'passengers' | 'punctuality';

export interface Plan {
  applied: Suggestion[];
  metrics: Metrics;
}

export interface DailyReport {
  date: string;
  base: Metrics;
  suggestions: Suggestion[];
  plans: Record<Objective, Plan>;
  incidents: IncidentImpact[];
  hotspots: StationHotspot[];
  /** Züge, die anderen am meisten Folgeverspätung eingebrockt haben. */
  spreaders: { trip: number; minutes: number; victims: number }[];
  simulations: number;
  baseRun: SimResult;
}

function applySuggestions(base: Policy, list: Suggestion[]): Policy {
  const p: Policy = { maxWait: base.maxWait, connectionOverride: new Map(base.connectionOverride), yields: [...base.yields] };
  for (const s of list) {
    if (s.kind === 'hold' || s.kind === 'release') p.connectionOverride.set(s.connection!, s.kind);
    else p.yields.push({ leader: s.trips[0], follower: s.trips[1], station: s.station });
  }
  return p;
}

/**
 * Tagesbericht: Bilanz, Ursachen und Gegenrechnung alternativer Dispositionsentscheidungen.
 * Jede Kandidatenentscheidung wird mit derselben Ausgangslage komplett neu simuliert,
 * anschließend werden die besten Entscheidungen gierig kombiniert.
 */
export function dailyReport(m: DayModel, opts: { candidates?: number } = {}): DailyReport {
  const policy = defaultPolicy();
  const baseRun = simulate(m, policy);
  const base = metrics(m, baseRun);
  let simulations = 1;
  const maxCandidates = opts.candidates ?? 24;

  const evaluate = (s: Omit<Suggestion, 'savedPassengerMinutes' | 'punctualityDelta'>): Suggestion => {
    const r = simulate(m, applySuggestions(policy, [s as Suggestion]));
    simulations++;
    const mm = metrics(m, r);
    return { ...s, savedPassengerMinutes: base.passengerDelayMinutes - mm.passengerDelayMinutes, punctualityDelta: (mm.punctuality - base.punctuality) * 100 };
  };

  const candidates: Omit<Suggestion, 'savedPassengerMinutes' | 'punctualityDelta'>[] = [];

  // a) Verpasste Anschlüsse, die man hätte halten können (viele Umsteiger, lange Wartezeit bis zur nächsten Fahrt).
  const missed = m.connections
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => {
      if (baseRun.connectionOutcome[i] !== 'missed') return false;
      const needed = baseRun.trips[c.feeder].arr[c.feederStop] + 3 - m.trips[c.departing].schedDep[c.departingStop];
      return needed <= 20;
    })
    .sort((a, b) => b.c.passengers * b.c.missPenalty - a.c.passengers * a.c.missPenalty)
    .slice(0, maxCandidates);
  for (const { c, i } of missed) {
    candidates.push({
      kind: 'hold',
      time: m.trips[c.departing].schedDep[c.departingStop],
      station: c.station,
      trips: [c.departing, c.feeder],
      connection: i,
      cost: Math.max(0, baseRun.trips[c.feeder].arr[c.feederStop] + 3 - baseRun.trips[c.departing].dep[c.departingStop]),
    });
  }

  // b) Gehaltene Anschlüsse, deren Wartezeit sich nicht gelohnt hat (volle Züge warten auf wenige Umsteiger).
  const held = m.connections
    .map((c, i) => ({ c, i, w: baseRun.connectionWait[i] }))
    .filter(({ i }) => baseRun.connectionOutcome[i] === 'held')
    .sort((a, b) => b.w * m.passengers[b.c.departing] - a.w * m.passengers[a.c.departing])
    .slice(0, maxCandidates);
  for (const { c, i, w } of held) {
    candidates.push({ kind: 'release', time: m.trips[c.departing].schedDep[c.departingStop], station: c.station, trips: [c.departing, c.feeder], connection: i, cost: -w });
  }

  // c) Reihenfolge: stark verspäteter Zug blockiert einen (fast) pünktlichen Folgezug.
  //    Bei der Abfahrt aufgelaufen → am selben Halt vorlassen; unterwegs aufgelaufen → am Halt davor.
  const yieldCands: { leader: number; follower: number; stop: number; minutes: number; time: number }[] = [];
  for (const t of m.trips) {
    const R = baseRun.trips[t.id];
    R.causes.forEach((cs, i) => {
      for (const c of cs) {
        if (c.type !== 'knockon' || c.minutes < 2) continue;
        const stop = c.side === 'dep' ? i : i - 1;
        if (stop < 0 || stop >= t.stops.length - 1) continue;
        const L = m.trips[c.trip];
        const li = L.stops.indexOf(t.stops[stop]);
        if (li < 0) continue;
        const leaderDelay = baseRun.trips[c.trip].dep[li] - L.schedDep[li];
        const followerDelay = R.arr[stop] - t.schedArr[stop];
        if (leaderDelay >= 8 && followerDelay < leaderDelay - 5) yieldCands.push({ leader: c.trip, follower: t.id, stop, minutes: c.minutes, time: R.dep[stop] });
      }
    });
  }
  yieldCands.sort((a, b) => b.minutes * m.passengers[b.follower] - a.minutes * m.passengers[a.follower]);
  const seen = new Set<string>();
  for (const y of yieldCands) {
    const k = `${y.leader}:${y.follower}`;
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push({ kind: 'yield', time: y.time, station: m.trips[y.follower].stops[y.stop], trips: [y.leader, y.follower], cost: HEADWAY_COST });
    if (seen.size >= maxCandidates * 2) break;
  }

  const evaluated = candidates.map(evaluate).filter((s) => s.savedPassengerMinutes > 50 || s.punctualityDelta > 0.005);

  // Gierig kombinieren – Entscheidungen beeinflussen sich gegenseitig.
  const plan = (objective: Objective): Plan => {
    const score = (x: Metrics) => (objective === 'passengers' ? -x.passengerDelayMinutes : x.punctual);
    const gain = (s: Suggestion) => (objective === 'passengers' ? s.savedPassengerMinutes : s.punctualityDelta);
    const applied: Suggestion[] = [];
    let best = base;
    for (const s of [...evaluated].filter((x) => gain(x) > 0).sort((a, b) => gain(b) - gain(a))) {
      const mm = metrics(m, simulate(m, applySuggestions(policy, [...applied, s])));
      simulations++;
      if (score(mm) > score(best) + (objective === 'passengers' ? 1 : 0)) {
        applied.push(s);
        best = mm;
      }
    }
    return { applied, metrics: best };
  };
  const plans = { passengers: plan('passengers'), punctuality: plan('punctuality') };

  return {
    date: m.date,
    base,
    suggestions: evaluated,
    plans,
    incidents: incidentImpact(m, baseRun),
    hotspots: hotspots(m, baseRun),
    spreaders: spreaders(baseRun),
    simulations,
    baseRun,
  };
}

const HEADWAY_COST = 3;

function incidentImpact(m: DayModel, r: SimResult): IncidentImpact[] {
  const minutes = new Map<number, number>();
  const trains = new Map<number, Set<number>>();
  r.trips.forEach((R, trip) => {
    for (const cs of R.causes) {
      for (const c of cs) {
        if (c.type !== 'incident') continue;
        minutes.set(c.incident, (minutes.get(c.incident) ?? 0) + c.minutes);
        (trains.get(c.incident) ?? trains.set(c.incident, new Set()).get(c.incident)!).add(trip);
      }
    }
  });
  return m.incidents
    .map((incident) => ({ incident, directMinutes: minutes.get(incident.id) ?? 0, trainsAffected: trains.get(incident.id)?.size ?? 0 }))
    .sort((a, b) => b.directMinutes - a.directMinutes);
}

function hotspots(m: DayModel, r: SimResult): StationHotspot[] {
  const gained = new Map<number, { minutes: number; trains: number }>();
  for (const t of m.trips) {
    const R = r.trips[t.id];
    for (let i = 1; i < t.stops.length; i++) {
      const before = Math.max(0, R.dep[i - 1] - t.schedDep[i - 1]);
      const after = Math.max(0, R.dep[i] - t.schedDep[i]);
      const g = after - before;
      if (g <= 0.5) continue;
      const s = t.stops[i];
      const e = gained.get(s) ?? { minutes: 0, trains: 0 };
      e.minutes += g;
      e.trains++;
      gained.set(s, e);
    }
  }
  return [...gained.entries()]
    .map(([station, e]) => ({ station, minutesGained: e.minutes, trains: e.trains }))
    .sort((a, b) => b.minutesGained - a.minutesGained)
    .slice(0, 10);
}

function spreaders(r: SimResult) {
  const caused = new Map<number, { minutes: number; victims: Set<number> }>();
  r.trips.forEach((R, trip) => {
    for (const cs of R.causes) {
      for (const c of cs) {
        if (c.type !== 'knockon' && c.type !== 'connection') continue;
        const e = caused.get(c.trip) ?? { minutes: 0, victims: new Set<number>() };
        e.minutes += c.minutes;
        e.victims.add(trip);
        caused.set(c.trip, e);
      }
    }
  });
  return [...caused.entries()]
    .map(([trip, e]) => ({ trip, minutes: e.minutes, victims: e.victims.size }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 8);
}
