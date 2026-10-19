/**
 * Lessons learned aus echten Ist-Daten: je Tag werden nur beobachtete Werte (keine Prognosen)
 * summierbar verdichtet, über viele Tage addiert und daraus Befunde mit Belastbarkeit abgeleitet.
 */
import { PUNCTUAL_LIMIT } from '../sim/analysis.ts';
import { MIN_TRANSFER } from '../sim/engine.ts';
import { inGermany, type DayModel } from '../sim/model.ts';
import { OBS_ARR, OBS_DEP, counts } from '../sim/real.ts';
import type { SimResult } from '../sim/types.ts';
import { topReasons, type ReasonSummary } from './reasons.ts';

/** Histogramm in ganzen Minuten von −10 bis +60 (Ränder gesammelt). */
const H_MIN = -10;
const H_MAX = 60;
const H_LEN = H_MAX - H_MIN + 1;
const bin = (v: number) => Math.min(H_LEN - 1, Math.max(0, Math.round(v) - H_MIN));

export interface Stat {
  n: number;
  /** Summe der Abweichungen (Minuten, kann negativ sein) */
  sum: number;
  /** Summe der verlorenen Minuten (nur positive Abweichungen) */
  lost: number;
  /** Anzahl mit Verlust ≥ Schwelle (2 Min; bei Startverspätung 3 Min) */
  hits: number;
  hist: number[];
  /** Tage mit Daten bzw. mit mindestens einem Treffer – trennt Dauerproblem von Einzelstörung */
  days: number;
  daysHit: number;
}

const emptyStat = (): Stat => ({ n: 0, sum: 0, lost: 0, hits: 0, hist: new Array(H_LEN).fill(0), days: 1, daysHit: 0 });

function add(s: Stat, v: number, threshold = 2) {
  s.n++;
  s.sum += v;
  if (v > 0) s.lost += v;
  if (v >= threshold) {
    s.hits++;
    s.daysHit = 1;
  }
  s.hist[bin(v)]++;
}

function mergeStat(a: Stat, b: Stat): Stat {
  return { n: a.n + b.n, sum: a.sum + b.sum, lost: a.lost + b.lost, hits: a.hits + b.hits, hist: a.hist.map((x, i) => x + (b.hist[i] ?? 0)), days: a.days + b.days, daysHit: a.daysHit + b.daysHit };
}

export function quantile(s: Stat, q: number): number {
  if (!s.n) return 0;
  let acc = 0;
  for (let i = 0; i < H_LEN; i++) {
    acc += s.hist[i];
    if (acc >= q * s.n) return i + H_MIN;
  }
  return H_MAX;
}

export interface TransferStat {
  n: number;
  missed: number;
  days: number;
  daysHit: number;
  /** Summe der geplanten Übergangszeiten */
  buffer: number;
}

export interface DayAgg {
  date: string;
  trips: number;
  arrivals: number;
  punctual: number;
  /** Abschnitt "A|B" (Bahnhofsnamen, gerichtet): Abweichung der Fahrzeit */
  sections: Record<string, Stat & { lines: Record<string, number> }>;
  /** Bahnhof: Verspätungszuwachs beim Halt */
  dwell: Record<string, Stat>;
  /** Startbahnhof: Verspätung bei Abfahrt */
  origins: Record<string, Stat>;
  /** Erster Halt in Deutschland nach Auslandsstart: mitgebrachte Verspätung */
  imports: Record<string, Stat & { from: Record<string, number> }>;
  /** Umstieg "Bahnhof|Zubringer-Linie|Anschluss-Linie" */
  transfers: Record<string, TransferStat>;
  /** Pünktlichkeit je Linie */
  lines: Record<string, { arrivals: number; punctual: number }>;
  /** Abfahrtsverspätung je "Bahnhof|Linie" – für "meist +3" auf der Abfahrtstafel */
  departures: Record<string, Stat>;
}

/** Verdichtet einen Tag. Nur beobachtete Werte zählen; Prognosen und Fahrten ohne Daten fallen weg. */
export function aggregateDay(m: DayModel, r: SimResult): DayAgg {
  const agg: DayAgg = { date: m.date, trips: 0, arrivals: 0, punctual: 0, sections: {}, dwell: {}, origins: {}, imports: {}, transfers: {}, lines: {}, departures: {} };
  const name = (s: number) => m.stations[s].name;
  for (const T of m.trips) {
    const R = r.trips[T.id];
    const obs = R.observed;
    if (!counts(R) || !obs) continue;
    agg.trips++;
    const n = T.stops.length;
    const line = (agg.lines[T.line] ??= { arrivals: 0, punctual: 0 });
    for (let i = 1; i < n; i++) {
      if (!(obs[i] & OBS_ARR) || !inGermany(m.stations[T.stops[i]])) continue;
      const late = R.arr[i] - T.schedArr[i] < PUNCTUAL_LIMIT;
      agg.arrivals++;
      line.arrivals++;
      if (late) {
        agg.punctual++;
        line.punctual++;
      }
    }
    // Startverspätung (nur Start in Deutschland)
    if (obs[0] & OBS_DEP && inGermany(m.stations[T.stops[0]])) add((agg.origins[name(T.stops[0])] ??= emptyStat()), R.dep[0] - T.schedDep[0], 3);
    // Mitgebrachte Verspätung aus dem Ausland
    if (!inGermany(m.stations[T.stops[0]])) {
      const k = T.stops.findIndex((s) => inGermany(m.stations[s]));
      if (k > 0 && obs[k] & OBS_ARR) {
        const e = (agg.imports[name(T.stops[k])] ??= { ...emptyStat(), from: {} });
        add(e, R.arr[k] - T.schedArr[k], PUNCTUAL_LIMIT);
        const origin = name(T.stops[0]);
        e.from[origin] = (e.from[origin] ?? 0) + 1;
      }
    }
    for (let i = 0; i + 1 < n; i++) {
      if (obs[i] & OBS_DEP) add((agg.departures[`${name(T.stops[i])}|${T.line}`] ??= emptyStat()), R.dep[i] - T.schedDep[i], PUNCTUAL_LIMIT);
      // Fahrzeit-Abweichung auf dem Abschnitt
      if (obs[i] & OBS_DEP && obs[i + 1] & OBS_ARR) {
        const dev = R.arr[i + 1] - R.dep[i] - (T.schedArr[i + 1] - T.schedDep[i]);
        const e = (agg.sections[`${name(T.stops[i])}|${name(T.stops[i + 1])}`] ??= { ...emptyStat(), lines: {} });
        add(e, dev);
        e.lines[T.line] = (e.lines[T.line] ?? 0) + 1;
      }
      // Zuwachs beim Halt (verfrühte Ankunft zählt nicht als Gewinn)
      if (i > 0 && obs[i] & OBS_ARR && obs[i] & OBS_DEP) {
        const gain = Math.max(0, R.dep[i] - T.schedDep[i]) - Math.max(0, R.arr[i] - T.schedArr[i]);
        add((agg.dwell[name(T.stops[i])] ??= emptyStat()), gain);
      }
    }
  }
  m.connections.forEach((c) => {
    const A = r.trips[c.feeder], B = r.trips[c.departing];
    if (!counts(A) || !counts(B) || !A.observed || !B.observed) return;
    if (!(A.observed[c.feederStop] & OBS_ARR) || !(B.observed[c.departingStop] & OBS_DEP)) return;
    const k = `${name(c.station)}|${m.trips[c.feeder].line}|${m.trips[c.departing].line}`;
    const e = (agg.transfers[k] ??= { n: 0, missed: 0, buffer: 0, days: 1, daysHit: 0 });
    e.n++;
    e.buffer += m.trips[c.departing].schedDep[c.departingStop] - m.trips[c.feeder].schedArr[c.feederStop];
    if (A.arr[c.feederStop] + MIN_TRANSFER > B.dep[c.departingStop] + 1e-6) {
      e.missed++;
      e.daysHit = 1;
    }
  });
  return agg;
}

function mergeRecord<T>(a: Record<string, T>, b: Record<string, T>, f: (x: T, y: T) => T): Record<string, T> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = out[k] ? f(out[k], v) : v;
  return out;
}

const mergeCounts = (a: Record<string, number>, b: Record<string, number>) => mergeRecord(a, b, (x, y) => x + y);

export interface MultiAgg extends Omit<DayAgg, 'date'> {
  dates: string[];
}

export function mergeDays(days: DayAgg[]): MultiAgg {
  let out: MultiAgg = { dates: [], trips: 0, arrivals: 0, punctual: 0, sections: {}, dwell: {}, origins: {}, imports: {}, transfers: {}, lines: {}, departures: {} };
  for (const d of days) {
    out = {
      dates: [...out.dates, d.date],
      trips: out.trips + d.trips,
      arrivals: out.arrivals + d.arrivals,
      punctual: out.punctual + d.punctual,
      sections: mergeRecord(out.sections, d.sections, (x, y) => ({ ...mergeStat(x, y), lines: mergeCounts(x.lines, y.lines) })),
      dwell: mergeRecord(out.dwell, d.dwell, mergeStat),
      origins: mergeRecord(out.origins, d.origins, mergeStat),
      imports: mergeRecord(out.imports, d.imports, (x, y) => ({ ...mergeStat(x, y), from: mergeCounts(x.from, y.from) })),
      transfers: mergeRecord(out.transfers, d.transfers, (x, y) => ({ n: x.n + y.n, missed: x.missed + y.missed, buffer: x.buffer + y.buffer, days: x.days + y.days, daysHit: x.daysHit + y.daysHit })),
      lines: mergeRecord(out.lines, d.lines, (x, y) => ({ arrivals: x.arrivals + y.arrivals, punctual: x.punctual + y.punctual })),
      // Ältere Tagesverdichtungen haben noch keine Abfahrtswerte
      departures: mergeRecord(out.departures, d.departures ?? {}, mergeStat),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Befunde

export type FindingKind = 'section' | 'dwell' | 'origin' | 'transfer' | 'import' | 'reserve';
export type Confidence = 'belastbar' | 'hinweis' | 'vorläufig';

export interface Finding {
  kind: FindingKind;
  place: string;
  /** Was die Daten zeigen */
  evidence: string;
  /** Was die DB tun könnte */
  measure: string;
  /** Verlorene Minuten pro Tag (Summe über alle Züge) – Maß für die Größe des Hebels */
  minutesPerDay: number;
  n: number;
  share: number;
  median: number;
  /** Häufigste von der DB gemeldete Gründe an diesem Ort (falls bekannt) */
  reasons?: string;
  /** An wie vielen der beobachteten Tage das Problem auftrat */
  daysHit: number;
  days: number;
  confidence: Confidence;
}

export interface Insights {
  dates: string[];
  trips: number;
  arrivals: number;
  punctuality: number;
  /** Woher die beobachtete Verspätung stammt (verlorene Minuten je Quelle) */
  sources: { sections: number; dwell: number; origins: number; imports: number };
  findings: Finding[];
  lines: { line: string; arrivals: number; punctuality: number }[];
  preliminary: boolean;
  /** Gemeldete Verspätungsgründe (IRIS) im selben Zeitraum */
  reasons?: ReasonSummary;
  /** Bisherige Umstiege "Bahnhof|Zubringer|Anschluss" → [beobachtet, verpasst] – für die Reiseplanung */
  transferHistory: Record<string, [number, number]>;
  /** Übliche Abfahrtsverspätung "Bahnhof|Linie" → [Abfahrten, Median, 80-%-Wert] in Minuten */
  typical: Record<string, [number, number, number]>;
}

/** Belastbar = genug Fälle, genug Tage und das Problem tritt an der Mehrzahl der Tage auf (keine Einzelstörung). */
function confidenceOf(n: number, s: { days: number; daysHit: number }): Confidence {
  const recurring = s.daysHit / Math.max(1, s.days);
  if (s.days >= 7 && n >= 40 && recurring >= 0.5) return 'belastbar';
  if (s.days >= 3 && n >= 15 && recurring >= 0.4) return 'hinweis';
  return 'vorläufig';
}

const onDays = (s: { days: number; daysHit: number }) => (s.days > 1 ? ` An ${s.daysHit} von ${s.days} Tagen.` : '');

const pct = (x: number) => `${Math.round(x * 100)} %`;
const short = (s: string) => s.replace(/ Hbf$/, '').replace(/ \(Main\)/, '');
const topLines = (lines: Record<string, number>) =>
  Object.entries(lines)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([l]) => l)
    .join(', ');

/** Leitet Befunde ab. Schwellen sind bewusst streng: lieber wenige, die halten. */
export function findings(agg: MultiAgg, opts: { minN?: number; reasons?: ReasonSummary } = {}): Insights {
  const days = Math.max(1, agg.dates.length);
  const minN = opts.minN ?? 8;
  const out: Finding[] = [];

  for (const [k, s] of Object.entries(agg.sections)) {
    if (s.n < minN) continue;
    const [a, b] = k.split('|');
    const share = s.hits / s.n, median = quantile(s, 0.5), p75 = quantile(s, 0.75);
    if (share >= 0.5 && median >= 2) {
      out.push({
        kind: 'section',
        place: `${short(a)} → ${short(b)}`,
        evidence: `${pct(share)} der Fahrten verlieren hier mindestens 2 Minuten, im Mittel ${median} Min (${s.n} Fahrten, v. a. ${topLines(s.lines)}).${onDays(s)}`,
        measure: `Fahrzeit im Fahrplan realistisch ansetzen (etwa +${Math.max(1, p75)} Min) oder die Ursache auf dem Abschnitt beheben: Langsamfahrstelle, Mischverkehr, Kapazität.`,
        minutesPerDay: s.lost / days,
        n: s.n,
        share,
        median,
        daysHit: s.daysHit,
        days: s.days,
        confidence: confidenceOf(s.n, s),
      });
    } else if (median <= -2 && s.hits / s.n < 0.15) {
      out.push({
        kind: 'reserve',
        place: `${short(a)} → ${short(b)}`,
        evidence: `Züge holen hier regelmäßig auf, im Mittel ${-median} Min (${s.n} Fahrten).${onDays(s)}`,
        measure: `Hier steckt Fahrzeitreserve. Prüfen, ob sie an einen der Verlust-Abschnitte davor oder danach verlagert werden kann.`,
        minutesPerDay: -s.sum / days,
        n: s.n,
        share: 1 - s.hits / s.n,
        median,
        daysHit: s.daysHit,
        days: s.days,
        confidence: confidenceOf(s.n, s),
      });
    }
  }
  for (const [st, s] of Object.entries(agg.dwell)) {
    if (s.n < minN) continue;
    const share = s.hits / s.n, median = quantile(s, 0.5), p75 = quantile(s, 0.75);
    if (share >= 0.4 && p75 >= 2) {
      out.push({
        kind: 'dwell',
        place: short(st),
        evidence: `${pct(share)} der Halte dauern mindestens 2 Minuten länger als geplant, im Mittel ${Math.max(median, 1)} Min (${s.n} Halte).${onDays(s)}`,
        measure: `Haltezeit im Fahrplan erhöhen oder den Fahrgastwechsel beschleunigen: Bahnsteiglotsen, Wagenreihung anzeigen, Einstieg auf ganzer Zuglänge.`,
        minutesPerDay: s.lost / days,
        n: s.n,
        share,
        median,
        daysHit: s.daysHit,
        days: s.days,
        confidence: confidenceOf(s.n, s),
      });
    }
  }
  for (const [st, s] of Object.entries(agg.origins)) {
    if (s.n < minN) continue;
    const share = s.hits / s.n, median = quantile(s, 0.5), p75 = quantile(s, 0.75);
    if (share >= 0.3 && p75 >= 3) {
      out.push({
        kind: 'origin',
        place: short(st),
        evidence: `${pct(share)} der hier startenden Züge fahren mindestens 3 Minuten zu spät ab (${s.n} Starts).${onDays(s)}`,
        measure: `Bereitstellung prüfen: Wende- und Reinigungszeiten, Weg aus der Abstellung, Personalwechsel. Den Zug früher am Bahnsteig bereitstellen.`,
        minutesPerDay: s.lost / days,
        n: s.n,
        share,
        median,
        daysHit: s.daysHit,
        days: s.days,
        confidence: confidenceOf(s.n, s),
      });
    }
  }
  for (const [st, s] of Object.entries(agg.imports)) {
    if (s.n < minN) continue;
    const share = s.hits / s.n, mean = s.sum / s.n;
    if (mean >= 5 && share >= 0.3) {
      out.push({
        kind: 'import',
        place: short(st),
        evidence: `Züge aus dem Ausland (${topLines(s.from)}) kommen hier im Schnitt mit ${Math.round(mean)} Min Verspätung an, ${pct(share)} mit 6 Min oder mehr (${s.n} Fahrten).${onDays(s)}`,
        measure: `Die Verspätung entsteht vor der Grenze. Hilfreich wären ein Puffer am Grenzübergang, ein Wechsel auf einen Zug aus dem Inland bei großer Verspätung, und die Abstimmung mit der Partnerbahn.`,
        minutesPerDay: s.lost / days,
        n: s.n,
        share,
        median: quantile(s, 0.5),
        daysHit: s.daysHit,
        days: s.days,
        confidence: confidenceOf(s.n, s),
      });
    }
  }
  for (const [k, t] of Object.entries(agg.transfers)) {
    if (t.n < minN) continue;
    const [st, from, to] = k.split('|');
    const share = t.missed / t.n;
    if (share >= 0.3) {
      out.push({
        kind: 'transfer',
        place: `${short(st)}: ${from} → ${to}`,
        evidence: `Der Umstieg mit geplant ${Math.round(t.buffer / t.n)} Min Übergang klappt nur in ${pct(1 - share)} der Fälle (${t.n} Beobachtungen).${onDays(t)}`,
        measure: `Übergangszeit im Fahrplan erhöhen oder den Anschluss aktiv sichern (Wartezeit von wenigen Minuten). Andernfalls nicht als Umstieg anbieten.`,
        minutesPerDay: (t.missed * 30) / days,
        n: t.n,
        share,
        median: 0,
        daysHit: t.daysHit,
        days: t.days,
        confidence: confidenceOf(t.n, t),
      });
    }
  }

  // Gemeldete Gründe an den betroffenen Bahnhöfen anhängen (bei Abschnitten: Startbahnhof des Abschnitts)
  if (opts.reasons) {
    for (const f of out) {
      const key = (f.kind === 'section' || f.kind === 'reserve' || f.kind === 'transfer' ? f.place.split(/ → |: /)[0] : f.place).trim();
      const st = Object.keys(opts.reasons.stations).find((n) => short(n) === key);
      const text = st ? topReasons(opts.reasons.stations[st]) : '';
      if (text && f.kind !== 'reserve') f.reasons = text;
    }
  }

  const rank = { belastbar: 0, hinweis: 1, vorläufig: 2 };
  out.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.minutesPerDay - a.minutesPerDay);

  const sum = (r: Record<string, Stat>) => Object.values(r).reduce((s, x) => s + x.lost, 0);
  return {
    dates: agg.dates,
    trips: agg.trips,
    arrivals: agg.arrivals,
    punctuality: agg.arrivals ? agg.punctual / agg.arrivals : 0,
    sources: { sections: sum(agg.sections), dwell: sum(agg.dwell), origins: sum(agg.origins), imports: sum(agg.imports) },
    findings: out,
    lines: Object.entries(agg.lines)
      .filter(([, l]) => l.arrivals >= minN)
      .map(([line, l]) => ({ line, arrivals: l.arrivals, punctuality: l.punctual / l.arrivals }))
      .sort((a, b) => a.punctuality - b.punctuality),
    preliminary: days < 3,
    reasons: opts.reasons,
    transferHistory: Object.fromEntries(Object.entries(agg.transfers).filter(([, t]) => t.n >= 3).map(([k, t]) => [k, [t.n, t.missed]])),
    typical: Object.fromEntries(Object.entries(agg.departures).filter(([, d]) => d.n >= 5).map(([k, d]) => [k, [d.n, quantile(d, 0.5), quantile(d, 0.8)]])),
  };
}
