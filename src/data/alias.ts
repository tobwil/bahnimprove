/**
 * gtfs.de vergibt bei neuen Fahrplanständen trip_ids und Haltnummern (stop_sequence) teils neu.
 * Die Echtzeitdaten sind aber unter den IDs und Haltnummern gespeichert, die beim Sammeln galten.
 * Damit nach einem neuen Fahrplan nichts verloren geht und keine Verspätung am falschen Bahnhof
 * landet, wird jede Fahrt der alten Version ihrer Entsprechung in der neuen zugeordnet (Linie,
 * Start, Abfahrt, Ziel am selben Verkehrstag) und jede Haltnummer über den Bahnhof übersetzt.
 */
import type { Timetable, TimetableTrip } from '../sim/types.ts';

/** Neue trip_id und – nur wenn abweichend – alte → neue Haltnummer als [alt, neu, alt, neu, …] */
export type AliasEntry = [string] | [string, number[]];

/** Verkehrstag → alte trip_id → Entsprechung im neuen Fahrplan */
export interface TripAlias {
  version?: string;
  dates: Record<string, Record<string, AliasEntry>>;
}

type Key = (tt: Timetable, t: TimetableTrip) => string;

// Vom genauesten zum gröbsten: geänderte Ziele (Baustelle) oder Startbahnhöfe fängt die nächste Stufe
const KEYS: Key[] = [
  (tt, t) => `${tt.routes[t.route]}|${tt.stations[t.stops[0]].name}|${t.times[1]}|${tt.stations[t.stops[t.stops.length - 1]].name}`,
  (tt, t) => `${tt.routes[t.route]}|${tt.stations[t.stops[0]].name}|${t.times[1]}`,
  (tt, t) => `${tt.routes[t.route]}|${tt.stations[t.stops[t.stops.length - 1]].name}|${t.times[t.times.length - 2]}`,
];

const runsOn = (tt: Timetable, t: TimetableTrip, date: string) => {
  const i = tt.dates.indexOf(date);
  return i >= 0 && ((t.days >>> i) & 1) === 1;
};

/** Haltnummern alt → neu über die Bahnhöfe (bei Schleifen die k-te Wiederkehr); undefined = gleich */
export function seqMap(oldTt: Timetable, a: TimetableTrip, newTt: Timetable, b: TimetableTrip): number[] | undefined {
  const where = new Map<string, number[]>();
  b.stops.forEach((s, i) => {
    const name = newTt.stations[s].name;
    where.set(name, [...(where.get(name) ?? []), b.seqs?.[i] ?? i]);
  });
  const seen = new Map<string, number>();
  const out: number[] = [];
  let same = a.stops.length === b.stops.length;
  a.stops.forEach((s, i) => {
    const name = oldTt.stations[s].name;
    const k = seen.get(name) ?? 0;
    seen.set(name, k + 1);
    const from = a.seqs?.[i] ?? i, to = where.get(name)?.[k];
    if (to === undefined) {
      same = false;
      return;
    }
    if (from !== to) same = false;
    out.push(from, to);
  });
  return same ? undefined : out;
}

/**
 * Zuordnung alt → neu je Verkehrstag; nur eindeutige Treffer, jede neue Fahrt höchstens einmal.
 * `only(date)`: alte IDs, für die an dem Tag Echtzeit vorliegt – andere sollen niemandem die
 * neue Fahrt wegnehmen.
 */
export function tripAlias(oldTt: Timetable, newTt: Timetable, dates: string[], only?: (date: string) => Set<string> | undefined): TripAlias {
  const out: TripAlias = { version: newTt.version, dates: {} };
  const newIds = new Set(newTt.trips.map((t) => t.id));
  const byId = new Map(newTt.trips.map((t) => [t.id, t]));
  for (const date of dates) {
    const running = newTt.trips.filter((t) => runsOn(newTt, t, date));
    const index = KEYS.map((key) => {
      const m = new Map<string, string | null>();
      for (const t of running) {
        const k = key(newTt, t);
        m.set(k, m.has(k) ? null : t.id);
      }
      return m;
    });
    // Alte Fahrten, die an diesem Tag fuhren, zuerst
    const keep = only?.(date);
    const old = oldTt.trips.filter((t) => !newIds.has(t.id) && (!keep || keep.has(t.id)));
    old.sort((a, b) => Number(runsOn(oldTt, b, date)) - Number(runsOn(oldTt, a, date)));
    const map: Record<string, AliasEntry> = {};
    const taken = new Set<string>();
    for (const t of old) {
      for (let k = 0; k < KEYS.length; k++) {
        const id = index[k].get(KEYS[k](oldTt, t));
        if (id === undefined) continue;
        if (id !== null && !taken.has(id)) {
          const seq = seqMap(oldTt, t, newTt, byId.get(id)!);
          map[t.id] = seq ? [id, seq] : [id];
          taken.add(id);
        }
        break;
      }
    }
    if (Object.keys(map).length) out.dates[date] = map;
  }
  return out;
}
