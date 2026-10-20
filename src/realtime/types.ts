/** Kompakte Echtzeitdaten eines Verkehrstags, gesammelt aus dem GTFS-Realtime-Feed von gtfs.de. */
export interface RealtimeDay {
  /** Verkehrstag YYYYMMDD (start_date der Fahrten) */
  date: string;
  /** Zeitstempel des zuletzt eingearbeiteten Feeds (Unix-Sekunden) */
  feedTime: number;
  trips: Record<string, RealtimeTrip>;
}

/** [stop_sequence, Ankunftsverspätung (Min) | null, Abfahrtsverspätung (Min) | null, 1 = Halt entfällt] */
export type StopUpdate = [number, number | null, number | null, 0 | 1];

export interface RealtimeTrip {
  /** Zuletzt im Feed gesehen (Unix-Sekunden) */
  seen: number;
  canceled?: 1;
  u: StopUpdate[];
}

/**
 * Eine Verspätung je Fahrt für den Überblick: die erste Meldung des Feeds (der nächste Halt –
 * vergangene Halte meldet der Feed nicht mehr), Ankunft vor Abfahrt.
 */
export function currentDelays(trips: Record<string, RealtimeTrip>): { d: Record<string, number>; x: string[] } {
  const d: Record<string, number> = {};
  const x: string[] = [];
  for (const [id, t] of Object.entries(trips)) {
    if (t.canceled) {
      x.push(id);
      continue;
    }
    const first = [...t.u].sort((a, b) => a[0] - b[0]).find((u) => !u[3] && (u[1] ?? u[2]) !== null);
    if (first) d[id] = Math.round(first[1] ?? first[2]!);
  }
  return { d, x };
}

/** Zwei Meldungsstände einer Fahrt vereinen: je Halt gewinnt der zuletzt gesehene. */
export function mergeTrip(a: RealtimeTrip, b: RealtimeTrip): RealtimeTrip {
  const [older, newer] = a.seen <= b.seen ? [a, b] : [b, a];
  const bySeq = new Map(older.u.map((u) => [u[0], u]));
  for (const u of newer.u) bySeq.set(u[0], u);
  return { seen: newer.seen, ...(newer.canceled ? { canceled: 1 } : {}), u: [...bySeq.values()].sort((x, y) => x[0] - y[0]) };
}

/**
 * Fahrten unter alten trip_ids auf die neuen umschreiben, Haltnummern mit (siehe data/alias.ts).
 * Nur wenn die alte ID dem aktuellen Fahrplan unbekannt ist und die neue bekannt – sonst bleibt
 * alles, wie es ist. Meldungen zu Halten ohne Entsprechung fallen weg.
 */
export function renameTrips(trips: Record<string, RealtimeTrip>, alias: Record<string, [string] | [string, number[]]> | undefined, known: (id: string) => boolean): number {
  if (!alias) return 0;
  let n = 0;
  for (const id of Object.keys(trips)) {
    const entry = alias[id];
    if (!entry || known(id) || !known(entry[0])) continue;
    const [to, pairs] = entry;
    let t = trips[id];
    if (pairs) {
      const seq = new Map<number, number>();
      for (let i = 0; i < pairs.length; i += 2) seq.set(pairs[i], pairs[i + 1]);
      t = { ...t, u: t.u.filter((u) => seq.has(u[0])).map((u) => [seq.get(u[0])!, u[1], u[2], u[3]] as StopUpdate) };
    }
    trips[to] = trips[to] ? mergeTrip(trips[to], t) : t;
    delete trips[id];
    n++;
  }
  return n;
}

/** Arbeitet neue Meldungen in einen Tag ein: neuere Werte je Halt gewinnen, ältere Halte bleiben erhalten. */
export function mergeDay(day: RealtimeDay | null, date: string, feedTime: number, trips: Record<string, RealtimeTrip>): RealtimeDay {
  const out: RealtimeDay = day && day.date === date ? { ...day, trips: { ...day.trips } } : { date, feedTime: 0, trips: {} };
  if (feedTime < out.feedTime) return out;
  out.feedTime = feedTime;
  for (const [id, t] of Object.entries(trips)) {
    const prev = out.trips[id];
    if (!prev) {
      out.trips[id] = t;
      continue;
    }
    const bySeq = new Map(prev.u.map((u) => [u[0], u]));
    for (const u of t.u) bySeq.set(u[0], u);
    out.trips[id] = { seen: t.seen, ...(t.canceled ? { canceled: 1 } : {}), u: [...bySeq.values()].sort((a, b) => a[0] - b[0]) };
  }
  return out;
}
