/**
 * GTFS-Realtime-Feed von gtfs.de (Daten: DELFI e.V.) lesen und auf den Fernverkehr reduzieren.
 * Nur serverseitig (Netlify Function, Skripte) – der Feed ist ~7 MB groß und ohne CORS.
 */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { RealtimeTrip, StopUpdate } from './types.ts';

export const FEED_URL = 'https://realtime.gtfs.de/realtime-free.pb';

const { transit_realtime: rt } = GtfsRealtimeBindings;
const TRIP_CANCELED = 3;
const STOP_SKIPPED = 1;

export async function fetchFeed(url = FEED_URL): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { 'User-Agent': 'bahnimprove (https://github.com/tobwil/bahnimprove)' } });
  if (!res.ok) throw new Error(`Echtzeit-Feed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const minutes = (sec: number | null | undefined) => (sec === null || sec === undefined ? null : Math.round((Number(sec) / 60) * 10) / 10);

/** Fahrten aus dem Feed, nach Gruppe (z. B. Fern-/Regionalverkehr) und Verkehrstag sortiert. */
export function extractGroups<G extends string>(buf: Uint8Array, classify: (tripId: string) => G | null) {
  const feed = rt.FeedMessage.decode(buf);
  const feedTime = Number(feed.header.timestamp ?? 0);
  const groups = new Map<G, Map<string, Record<string, RealtimeTrip>>>();
  for (const e of feed.entity) {
    const tu = e.tripUpdate;
    const id = tu?.trip?.tripId;
    if (!tu || !id) continue;
    const group = classify(id);
    if (!group) continue;
    const date = tu.trip.startDate || '';
    const u: StopUpdate[] = [];
    for (const s of tu.stopTimeUpdate ?? []) {
      if (s.stopSequence === null || s.stopSequence === undefined) continue;
      const skipped = s.scheduleRelationship === STOP_SKIPPED ? 1 : 0;
      const a = s.arrival ? minutes(s.arrival.delay) : null;
      const d = s.departure ? minutes(s.departure.delay) : null;
      if (a === null && d === null && !skipped) continue;
      u.push([s.stopSequence, a, d, skipped]);
    }
    const trip: RealtimeTrip = { seen: feedTime, u };
    if (tu.trip.scheduleRelationship === TRIP_CANCELED) trip.canceled = 1;
    let byDate = groups.get(group);
    if (!byDate) groups.set(group, (byDate = new Map()));
    let list = byDate.get(date);
    if (!list) byDate.set(date, (list = {}));
    list[id] = trip;
  }
  return { feedTime, groups };
}

/** Fahrten mit den angegebenen IDs aus dem Feed, gruppiert nach Verkehrstag. */
export function extractTrips(buf: Uint8Array, tripIds: Set<string>) {
  const { feedTime, groups } = extractGroups(buf, (id) => (tripIds.has(id) ? 'all' : null));
  return { feedTime, byDate: groups.get('all') ?? new Map<string, Record<string, RealtimeTrip>>() };
}
