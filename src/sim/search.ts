import type { DayModel } from './model.ts';
import type { SimResult } from './types.ts';

/** Kleinbuchstaben, Umlaute und Satzzeichen vereinheitlicht ("Köln Hbf" ≈ "koeln hbf" ≈ "koln"). */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type TripStatus = 'running' | 'upcoming' | 'done';

export interface TripHit {
  trip: number;
  status: TripStatus;
  /** Abfahrt am ersten passenden Halt (Soll) */
  time: number;
  /** Halt-Index, an dem die Suche passt (für die Anzeige "ab Köln 14:05") */
  stop: number;
}

export interface SearchResult {
  stations: number[];
  trips: TripHit[];
}

/** Linie oder Zugnummer: "ICE 28", "re4", "S 5", "28" */
const LINE = /^([a-z]{1,4})?\s*(\d{1,5})$/;
/** Linie als Schlüssel: "RE 19" → "re19" */
export const lineKey = (line: string) => fold(line).replace(/\s/g, '');

export interface LineQuery {
  cat?: string;
  no: string;
  /** Wörter nach der Linie (Bahnhöfe) */
  rest: string[];
}

/** Erkennt eine Linie oder Zugnummer am Anfang der Suche ("ICE 28", "RE 4", "S5", "28") */
export function lineQuery(words: string[]): LineQuery | null {
  for (const take of [2, 1]) {
    const lm = LINE.exec(words.slice(0, take).join(' '));
    if (lm && (take === 1 || /^\d/.test(words[1]))) return { cat: lm[1], no: lm[2], rest: words.slice(take) };
  }
  return null;
}

/** Passt ein Linienschlüssel zur Suche? Ohne Gattung zählt nur die Nummer am Ende ("28" ≠ "128") */
export function lineMatches(key: string, q: { cat?: string; no: string }): boolean {
  return q.cat ? key === `${q.cat}${q.no}` : key.endsWith(q.no) && !/\d/.test(key.slice(-q.no.length - 1, -q.no.length));
}

/** Suchwörter ohne Füllwörter */
export const searchWords = (query: string) => fold(query.replace(/→|->/g, ' ')).split(' ').filter((w) => w && w !== 'nach' && w !== 'von' && w !== 'bis');

/** Bahnhöfe, deren Name alle Suchwörter enthält – wichtigste zuerst, Wortanfänge bevorzugt. */
export function matchStations(m: DayModel, query: string | string[], limit = 6): number[] {
  const tokens = (Array.isArray(query) ? query : [query]).map(fold).filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  const scored: { i: number; score: number }[] = [];
  m.stations.forEach((s, i) => {
    if ((s.w ?? s.weight) < 1 || /\(Gr\)|Grenze/.test(s.name)) return;
    const n = fold(s.name);
    if (!tokens.every((t) => n.includes(t))) return;
    const pos = n.indexOf(tokens[0]);
    const wordStart = pos === 0 || n[pos - 1] === ' ';
    scored.push({ i, score: (s.weight * 5 + (s.w ?? 0) + 1) * (pos === 0 ? 4 : wordStart ? 2 : 1) * (n.includes('hbf') ? 1.5 : 1) });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.i);
}

export function search(m: DayModel, r: SimResult, query: string, now: number): SearchResult {
  if (!fold(query)) return { stations: [], trips: [] };
  const words = searchWords(query);
  // Linie oder Zugnummer – nur wenn das Wort kein Bahnhof sein soll
  const line = lineQuery(words);
  const rest = line ? line.rest : words;

  // Restliche Wörter als Bahnhöfe (mehrteilige Namen werden zusammengefasst)
  const stationSets: number[][] = [];
  for (let i = 0; i < rest.length; i++) {
    const tokens = [rest[i]];
    let best = matchStations(m, tokens, 40);
    // "frankfurt flughafen": weiteres Wort verfeinert, statt einen neuen Bahnhof zu beginnen
    while (i + 1 < rest.length) {
      const refined = matchStations(m, [...tokens, rest[i + 1]], 40);
      if (!refined.length) break;
      tokens.push(rest[++i]);
      best = refined;
    }
    if (best.length) stationSets.push(best);
  }

  const trips: TripHit[] = [];
  for (const T of m.trips) {
    if (line && !lineMatches(lineKey(T.line), line)) continue;
    // Bahnhöfe in Fahrtrichtung
    let stop = 0;
    let ok = true;
    let first = -1;
    for (const set of stationSets) {
      let found = -1;
      for (let i = stop; i < T.stops.length; i++) {
        if (set.includes(T.stops[i])) {
          found = i;
          break;
        }
      }
      if (found < 0 || (stationSets.length > 1 && found === T.stops.length - 1 && set === stationSets[0])) {
        ok = false;
        break;
      }
      if (first < 0) first = found;
      stop = found + 1;
    }
    if (!ok || (!line && !stationSets.length)) continue;
    const R = r.trips[T.id];
    const status: TripStatus = R.canceled || R.arr[T.stops.length - 1] < now ? 'done' : R.dep[0] > now ? 'upcoming' : 'running';
    const s = Math.max(0, first);
    trips.push({ trip: T.id, status, time: s === T.stops.length - 1 ? T.schedArr[s] : T.schedDep[s], stop: s });
  }

  const order: Record<TripStatus, number> = { running: 0, upcoming: 1, done: 2 };
  trips.sort((a, b) => {
    if (a.status !== b.status) return order[a.status] - order[b.status];
    // Laufende und kommende: nach Zeit; vergangene: neueste zuerst
    return a.status === 'done' ? b.time - a.time : a.time - b.time;
  });
  // Bei einer Bahnhofssuche zuerst die nächsten Abfahrten dort
  if (stationSets.length === 1 && !line) {
    trips.sort((a, b) => {
      const fa = a.time >= now - 2, fb = b.time >= now - 2;
      return fa !== fb ? (fa ? -1 : 1) : fa ? a.time - b.time : b.time - a.time;
    });
  }
  return { stations: stationSets.length === 1 ? stationSets[0].slice(0, 4) : [], trips: trips.slice(0, 40) };
}
