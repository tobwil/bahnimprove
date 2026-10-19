/**
 * "Live mitfahren": Stand einer geteilten Zugfahrt bis zum Ausstieg – für die Ansicht der
 * Empfänger in der App und für die Vorschaukarte im Messenger.
 */
import { trainAt } from '../sim/live.ts';
import type { DayModel } from '../sim/model.ts';
import { hhmm, shortName } from '../sim/text.ts';
import type { SimResult, TimetableStation, Trip, TripResult } from '../sim/types.ts';

/** Ab dieser erwarteten Verspätung (Minuten) wird aus "Share your Train" "Share your T̶r̶a̶i̶n̶ Pain" */
export const PAIN_MIN = 15;
export const isPain = (delay: number, canceled = false) => canceled || delay >= PAIN_MIN;

export type FollowState = 'before' | 'running' | 'arrived' | 'canceled';

export interface FollowStatus {
  line: string;
  from: string;
  to: string;
  /** Ausstieg */
  target: string;
  targetIndex: number;
  state: FollowState;
  schedArr: number;
  estArr: number;
  /** Erwartete Verspätung am Ausstieg in Minuten (0 ohne Echtzeit) */
  delay: number;
  /** Echtzeitdaten vorhanden */
  known: boolean;
  /** "zwischen Würzburg und Fulda", "in Fulda", "Abfahrt 07:34 in Hamburg" */
  where: string;
  /** 0…1 Fortschritt von der Abfahrt bis zum Ausstieg (nach Zeit) */
  progress: number;
  minutesLeft: number;
  next?: { name: string; time: number };
}

/** Halt-Index eines Bahnhofs (nach Name) auf der Fahrt; sonst Endhalt. */
export function targetIndexOf(stations: TimetableStation[], T: Trip, name: string | null | undefined): number {
  if (name) {
    const i = T.stops.findIndex((s, k) => k > 0 && stations[s].name === name);
    if (i > 0) return i;
  }
  return T.stops.length - 1;
}

export function followStatus(stations: TimetableStation[], T: Trip, R: TripResult, targetIndex: number, now: number): FollowStatus {
  const n = T.stops.length;
  const ti = Math.min(n - 1, Math.max(1, targetIndex));
  const name = (i: number) => shortName(stations[T.stops[i]].name);
  const known = R.known !== false;
  const schedArr = T.schedArr[ti];
  const estArr = R.canceled ? schedArr : R.arr[ti];
  const delay = known && !R.canceled ? Math.max(0, Math.round(estArr - schedArr)) : 0;
  const s = trainAt({ trips: [T] } as unknown as DayModel, { trips: [R] } as unknown as SimResult, 0, now);
  const state: FollowState = R.canceled ? 'canceled' : now >= estArr ? 'arrived' : now < R.dep[0] ? 'before' : 'running';
  const where =
    state === 'canceled'
      ? 'Der Zug fällt aus'
      : state === 'arrived'
        ? `angekommen in ${name(ti)}`
        : state === 'before' || !s
          ? `Abfahrt ${hhmm(R.dep[0])} in ${name(0)}`
          : s.atStation
            ? `in ${name(s.stop)}`
            : `zwischen ${name(s.stop)} und ${name(s.stop + 1)}`;
  const span = Math.max(1, estArr - R.dep[0]);
  const progress = state === 'arrived' ? 1 : Math.min(1, Math.max(0, (now - R.dep[0]) / span));
  let next: FollowStatus['next'];
  for (let i = 1; i <= ti; i++) {
    if (R.arr[i] > now) {
      next = { name: name(i), time: R.arr[i] };
      break;
    }
  }
  return {
    line: T.line,
    from: name(0),
    to: name(n - 1),
    target: name(ti),
    targetIndex: ti,
    state,
    schedArr,
    estArr,
    delay,
    known,
    where,
    progress,
    minutesLeft: Math.max(0, Math.round(estArr - now)),
    next,
  };
}

/** Ein Satz für Vorschau und Teilen-Text: "Tobi kommt um 13:47 in Nürnberg an (+32 Min)". */
export function followHeadline(st: FollowStatus, who?: string): string {
  const subject = who || 'Der Zug';
  if (st.state === 'canceled') return `${st.line} nach ${st.to} fällt aus`;
  if (st.state === 'arrived') return `${subject} ist in ${st.target} angekommen (${hhmm(st.estArr)})`;
  return `${subject} kommt um ${hhmm(st.estArr)} in ${st.target} an${st.delay >= 1 ? ` (+${st.delay} Min)` : ''}`;
}

/** Namen aus Links: nur Buchstaben, Leerzeichen und Bindestrich, höchstens 20 Zeichen. */
export function cleanName(raw: string | null | undefined): string {
  // Ältere Links ohne Abschluss: von Messengern angehängter Text beginnt mit "Ich sitze"
  const name = (raw ?? '').split(/\s+Ich sitze/i)[0];
  return name.replace(/[^\p{L} \-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20).trim();
}
