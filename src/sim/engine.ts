import { edgeKey, stopKey, type DayModel } from './model.ts';
import type { Cause, Policy, SimResult, TripResult } from './types.ts';

/** Mindestzugfolge auf einem Abschnitt in Minuten. */
export const HEADWAY = 3;
/** Mindestumsteigezeit in Minuten. */
export const MIN_TRANSFER = 3;
/** Fahrzeitreserve, die ein verspäteter Zug aufholen kann. */
const RESERVE = 0.04;
const MIN_DWELL = 1;
/** Längste Wartezeit, die ein Vorschlag "Anschluss halten" anordnen darf. */
export const MAX_OVERRIDE_WAIT = 20;
/** Längste Wartezeit beim Vorlassen eines anderen Zugs. */
const MAX_YIELD_WAIT = 15;

export const defaultPolicy = (): Policy => ({ maxWait: 3, connectionOverride: new Map(), yields: [] });

/** Binärer Min-Heap über (Zeit, Fahrt) – deterministisch bei gleichen Zeiten. */
class EventQueue {
  private t: number[] = [];
  private trip: number[] = [];
  private stop: number[] = [];
  get size() {
    return this.t.length;
  }
  private less(i: number, j: number) {
    return this.t[i] < this.t[j] || (this.t[i] === this.t[j] && this.trip[i] < this.trip[j]);
  }
  private swap(i: number, j: number) {
    [this.t[i], this.t[j]] = [this.t[j], this.t[i]];
    [this.trip[i], this.trip[j]] = [this.trip[j], this.trip[i]];
    [this.stop[i], this.stop[j]] = [this.stop[j], this.stop[i]];
  }
  push(t: number, trip: number, stop: number) {
    this.t.push(t);
    this.trip.push(trip);
    this.stop.push(stop);
    let i = this.t.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number, number] {
    const top: [number, number, number] = [this.t[0], this.trip[0], this.stop[0]];
    const last = this.t.length - 1;
    this.swap(0, last);
    this.t.pop();
    this.trip.pop();
    this.stop.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.t.length && this.less(l, m)) m = l;
      if (r < this.t.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

interface Hold {
  /** Zeitpunkt, ab dem der Zug abfahrbereit war. */
  base: number;
  reason?: { type: 'connection' | 'yield'; trip: number };
}

/**
 * Ereignisbasierte Simulation eines Verkehrstags.
 *
 * Modell: Züge fahren Halt für Halt. Auf jedem Abschnitt gilt eine Mindestzugfolge und
 * Überholverbot (Folgeverspätung). Streckenstörungen sperren Abschnitte oder kosten Fahrzeit,
 * verspätete Züge holen Fahrzeitreserven auf, Anschlusszüge warten nach `policy`.
 */
export function simulate(m: DayModel, policy: Policy): SimResult {
  const { trips } = m;
  const res: TripResult[] = trips.map((t) => ({
    arr: t.stops.map(() => NaN),
    dep: t.stops.map(() => NaN),
    causes: t.stops.map(() => [] as Cause[]),
  }));
  const delay = new Float64Array(trips.length);
  const lastDep = new Map<number, { t: number; trip: number }>();
  const lastArr = new Map<number, { t: number; trip: number }>();
  const holds = new Map<number, Hold>();
  const connectionWait = new Float64Array(m.connections.length);

  const yields = new Map<number, { follower: number; followerStop: number }[]>();
  for (const y of policy.yields) {
    const li = trips[y.leader].stops.indexOf(y.station);
    const fi = trips[y.follower].stops.indexOf(y.station);
    if (li < 0 || fi < 0) continue;
    const k = stopKey(y.leader, li);
    (yields.get(k) ?? yields.set(k, []).get(k)!).push({ follower: y.follower, followerStop: fi });
  }

  const q = new EventQueue();
  for (const t of trips) {
    res[t.id].arr[0] = t.schedArr[0];
    const origin = m.originDelay[t.id];
    if (origin > 0) res[t.id].causes[0].push({ type: 'origin', minutes: origin });
    q.push(t.schedDep[0] + origin, t.id, 0);
  }

  /** Erwartete Ankunft bzw. Abfahrbereitschaft eines anderen Zugs aus Sicht des Fahrdienstleiters. */
  const expectedArr = (trip: number, stop: number) => {
    const a = res[trip].arr[stop];
    return Number.isNaN(a) ? trips[trip].schedArr[stop] + Math.max(0, delay[trip]) : a;
  };

  while (q.size) {
    const [t, id, i] = q.pop();
    const T = trips[id];
    const R = res[id];
    const hk = stopKey(id, i);
    let hold = holds.get(hk);
    if (!hold) holds.set(hk, (hold = { base: t }));

    // 1) Anschlüsse abwarten
    let waitUntil = t;
    let waitFor = -1;
    let waitConn = -1;
    for (const c of m.connectionsByDeparture.get(hk) ?? []) {
      const C = m.connections[c];
      const override = policy.connectionOverride.get(c);
      if (override === 'release') continue;
      const need = expectedArr(C.feeder, C.feederStop) + MIN_TRANSFER;
      if (need <= t) continue;
      const limit = override === 'hold' ? MAX_OVERRIDE_WAIT : policy.maxWait;
      if (need - Math.max(hold.base, T.schedDep[i]) <= limit && need > waitUntil) {
        waitUntil = need;
        waitFor = C.feeder;
        waitConn = c;
      }
    }
    if (waitUntil > t) {
      hold.reason = { type: 'connection', trip: waitFor };
      connectionWait[waitConn] = waitUntil - hold.base;
      q.push(waitUntil, id, i);
      continue;
    }

    // 2) Anderen Zug vorlassen (Überholung)
    let yielded = false;
    for (const y of yields.get(hk) ?? []) {
      if (!Number.isNaN(res[y.follower].dep[y.followerStop])) continue;
      const fr = trips[y.follower];
      const est = Math.max(expectedArr(y.follower, y.followerStop), fr.schedDep[y.followerStop] + Math.max(0, delay[y.follower]));
      if (est - hold.base > MAX_YIELD_WAIT || t - hold.base > MAX_YIELD_WAIT) continue;
      hold.reason = { type: 'yield', trip: y.follower };
      q.push(Math.max(t + 0.5, est), id, i);
      yielded = true;
      break;
    }
    if (yielded) continue;

    if (t > hold.base + 1e-9 && hold.reason) {
      R.causes[i].push({ type: hold.reason.type, trip: hold.reason.trip, minutes: t - hold.base });
    }

    // 3) Abfahrt
    const from = T.stops[i];
    const to = T.stops[i + 1];
    const ek = edgeKey(from, to);
    const incs = m.edgeIncidents.get(ek) ?? [];
    let dep = t;
    for (let pass = 0; pass < 2; pass++) {
      for (const inc of incs) {
        if (inc.blocking && inc.start <= dep && dep < inc.end) {
          R.causes[i].push({ type: 'incident', incident: inc.id, minutes: inc.end - dep });
          dep = inc.end;
        }
      }
    }
    let headway = HEADWAY;
    for (const inc of incs) if (inc.headway && inc.start <= dep && dep < inc.end) headway = Math.max(headway, inc.headway);
    const ld = lastDep.get(ek);
    if (ld && dep < ld.t + headway) {
      R.causes[i].push({ type: 'knockon', trip: ld.trip, minutes: ld.t + headway - dep, side: 'dep' });
      dep = ld.t + headway;
    }
    R.dep[i] = dep;
    delay[id] = dep - T.schedDep[i];
    lastDep.set(ek, { t: dep, trip: id });

    // 4) Fahrt zum nächsten Halt
    const sched = T.schedArr[i + 1] - T.schedDep[i];
    const late = dep - T.schedDep[i];
    let run = late > 0 ? Math.max(sched * (1 - RESERVE), sched - late) : sched;
    for (const inc of incs) {
      if (!inc.blocking && inc.extra > 0 && inc.start <= dep && dep < inc.end) {
        run += inc.extra;
        R.causes[i + 1].push({ type: 'incident', incident: inc.id, minutes: inc.extra });
      }
    }
    const ops = m.opsNoise[id][i];
    run += ops;
    if (ops >= 1) R.causes[i + 1].push({ type: 'ops', minutes: ops });
    let arr = dep + run;
    const la = lastArr.get(ek);
    if (la && arr < la.t + headway) {
      R.causes[i + 1].push({ type: 'knockon', trip: la.trip, minutes: la.t + headway - arr, side: 'arr' });
      arr = la.t + headway;
    }
    lastArr.set(ek, { t: arr, trip: id });
    R.arr[i + 1] = arr;
    delay[id] = arr - T.schedArr[i + 1];

    const last = T.stops.length - 1;
    if (i + 1 === last) {
      R.dep[last] = arr;
      continue;
    }

    // 5) Halt
    const schedDwell = T.schedDep[i + 1] - T.schedArr[i + 1];
    let ready = Math.max(T.schedDep[i + 1], arr + Math.min(schedDwell, MIN_DWELL));
    const crowd = m.dwellNoise[id][i + 1];
    if (crowd > 0 && delay[id] > 5) {
      ready += crowd;
      R.causes[i + 1].push({ type: 'dwell', minutes: crowd });
    }
    for (const inc of m.stopIncidents.get(stopKey(id, i + 1)) ?? []) {
      ready += inc.extra;
      R.causes[i + 1].push({ type: 'incident', incident: inc.id, minutes: inc.extra });
    }
    q.push(ready, id, i + 1);
  }

  const connectionOutcome = m.connections.map((c, i) => {
    const arr = res[c.feeder].arr[c.feederStop];
    const dep = res[c.departing].dep[c.departingStop];
    if (arr + MIN_TRANSFER > dep + 1e-6) return 'missed' as const;
    return connectionWait[i] > 0.01 ? ('held' as const) : ('kept' as const);
  });
  return { trips: res, connectionOutcome, connectionWait: [...connectionWait] };
}
