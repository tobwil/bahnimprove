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

/**
 * Treibhausgase je Personenkilometer in g CO₂e, Umweltbundesamt, TREMOD 6.71B, Bezugsjahr 2024
 * (inkl. Vorkette; Pkw bei durchschnittlich 1,4 Personen).
 */
export const CO2_G_PKM = { car: 164, longDistance: 26, regional: 44 } as const;
const LONG_DISTANCE = new Set(['ICE', 'IC', 'EC', 'ECE', 'EN', 'NJ', 'RJ', 'RJX', 'TGV', 'FLX', 'ES']);

/** Luftlinie zwischen aufeinanderfolgenden Halten, aufsummiert (eher zu wenig als zu viel) */
function routeKm(stations: TimetableStation[], stops: number[], from: number, to: number): number {
  let km = 0;
  for (let i = from; i < to; i++) {
    const a = stations[stops[i]], b = stations[stops[i + 1]];
    const dy = (b.lat - a.lat) * 111.2, dx = (b.lon - a.lon) * 111.2 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    km += Math.hypot(dx, dy);
  }
  return km;
}

/** Gesparte kg CO₂e pro Person gegenüber dem Auto auf dieser Strecke */
export function co2SavedKg(category: string, km: number): number {
  const train = LONG_DISTANCE.has(category) ? CO2_G_PKM.longDistance : CO2_G_PKM.regional;
  return ((CO2_G_PKM.car - train) * km) / 1000;
}

export type FollowState = 'before' | 'running' | 'arrived' | 'canceled';

export interface FollowStatus {
  line: string;
  from: string;
  to: string;
  /** Einstieg und Ausstieg */
  board: string;
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
  /** Strecke vom Ein- bis zum Ausstieg und dabei gegenüber dem Auto gesparte kg CO₂e pro Person */
  km: number;
  co2Kg: number;
}

/** Halt-Index eines Bahnhofs (nach Name) auf der Fahrt; sonst Endhalt. */
export function targetIndexOf(stations: TimetableStation[], T: Trip, name: string | null | undefined): number {
  if (name) {
    const i = T.stops.findIndex((s, k) => k > 0 && stations[s].name === name);
    if (i > 0) return i;
  }
  return T.stops.length - 1;
}

/** Halt-Index des Einstiegs (nach Name); sonst Start der Fahrt. */
export function boardIndexOf(stations: TimetableStation[], T: Trip, name: string | null | undefined): number {
  if (!name) return 0;
  const i = T.stops.findIndex((s, k) => k < T.stops.length - 1 && stations[s].name === name);
  return Math.max(0, i);
}

export function followStatus(stations: TimetableStation[], T: Trip, R: TripResult, targetIndex: number, now: number, boardIndex = 0): FollowStatus {
  const n = T.stops.length;
  const ti = Math.min(n - 1, Math.max(1, targetIndex));
  const bi = Math.min(ti - 1, Math.max(0, boardIndex));
  const km = routeKm(stations, T.stops, bi, ti);
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
  // Fortschritt ab dem Einstieg
  const span = Math.max(1, estArr - R.dep[bi]);
  const progress = state === 'arrived' ? 1 : Math.min(1, Math.max(0, (now - R.dep[bi]) / span));
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
    board: name(bi),
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
    km,
    co2Kg: co2SavedKg(T.category, km),
  };
}

/** Ein Satz für Vorschau und Teilen-Text: "Tobi kommt um 13:47 in Nürnberg an (+32 Min)". */
export function followHeadline(st: FollowStatus, who?: string): string {
  const subject = who || 'Der Zug';
  if (st.state === 'canceled') return `${st.line} nach ${st.to} fällt aus`;
  if (st.state === 'arrived') return `${subject} ist in ${st.target} angekommen (${hhmm(st.estArr)})`;
  return `${subject} kommt um ${hhmm(st.estArr)} in ${st.target} an${st.delay >= 1 ? ` (+${st.delay} Min)` : ''}`;
}

/** Positive Zeile zum CO₂: bei großer Verspätung mit Augenzwinkern */
export function co2Line(st: FollowStatus): string {
  const kg = Math.round(st.co2Kg);
  if (kg < 1) return '';
  const what = `rund ${kg} kg CO₂ weniger als mit dem Auto (${st.board}–${st.target}, pro Person)`;
  return isPain(st.delay, st.state === 'canceled') ? `Pain is temporary, CO₂ reduction is forever: ${what}.` : `Gute Wahl: ${what}.`;
}

/** Namen aus Links: nur Buchstaben, Leerzeichen und Bindestrich, höchstens 20 Zeichen. */
export function cleanName(raw: string | null | undefined): string {
  // Ältere Links ohne Abschluss: von Messengern angehängter Text beginnt mit "Ich sitze"
  const name = (raw ?? '').split(/\s+Ich sitze/i)[0];
  return name.replace(/[^\p{L} \-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20).trim();
}
