import { getStore } from '@netlify/blobs';
import bundledTimetable from '../public/data/timetable.json' with { type: 'json' };
import irisStations from '../public/data/iris-stations.json' with { type: 'json' };
import type { TripAlias } from '../src/data/alias.ts';
import { addMessages, mergeReasons, parseIrisMessages, type ReasonDay } from '../src/insights/reasons.ts';
import type { OverviewChunk, OverviewDelays, RegionalIndex, RegionalTile } from '../src/data/regional.ts';
import { aggregateDay, findings, mergeDays, type DayAgg, type Insights } from '../src/insights/aggregate.ts';
import { extractGroups, fetchFeed } from '../src/realtime/feed.ts';
import { currentDelays, mergeDay, renameTrips, type RealtimeDay } from '../src/realtime/types.ts';
import { buildDayModel, categoryOf, type DayModel } from '../src/sim/model.ts';
import { berlinMidnightEpoch, observeTrip, observedResult } from '../src/sim/real.ts';
import type { Timetable, TimetableStation, Trip, TripResult } from '../src/sim/types.ts';

/** Echtzeit je Verkehrstag: Fernverkehr unter "YYYYMMDD", Regionalverkehr unter "rv/YYYYMMDD". */
export const store = () => getStore('realtime');
/** Vom nächtlichen Job erzeugter Fahrplan: "timetable", "rv-index", "rv-trip-tiles". */
export const staticStore = () => getStore('static');
/** Regionalkacheln "version/YYYYMMDD/kachel" */
export const tileStore = () => getStore('rvtiles');
const aggStore = () => getStore('insights');

/** Wie viele Tage die Lessons learned zurückblicken. */
const WINDOW_DAYS = 28;
const CACHE_MS = 5 * 60_000;

/** Verkehrstag (YYYYMMDD) in Berlin; bis 03:00 zählt noch der Vortag. */
export function serviceDate(now = new Date()): string {
  const berlin = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  if (berlin.getHours() < 3) berlin.setDate(berlin.getDate() - 1);
  return `${berlin.getFullYear()}${String(berlin.getMonth() + 1).padStart(2, '0')}${String(berlin.getDate()).padStart(2, '0')}`;
}

let ttCache: { at: number; tt: Timetable } | null = null;
/** Aktueller Fahrplan: aus dem nächtlichen Job, sonst der beim Deploy mitgelieferte. */
export async function timetable(): Promise<Timetable> {
  if (ttCache && Date.now() - ttCache.at < CACHE_MS) return ttCache.tt;
  const text = await staticStore().get('timetable', { type: 'text' });
  const tt = text ? (JSON.parse(text) as Timetable) : (bundledTimetable as unknown as Timetable);
  ttCache = { at: Date.now(), tt };
  return tt;
}

let rvCache: { at: number; version: string; map: Record<string, string[]> } | null = null;
export async function rvTripTiles() {
  if (rvCache && Date.now() - rvCache.at < CACHE_MS) return rvCache;
  const data = (await staticStore().get('rv-trip-tiles', { type: 'json' })) as { version: string; map: Record<string, string[]> } | null;
  rvCache = data ? { at: Date.now(), ...data } : null;
  return rvCache;
}

let aliasCache: { at: number; alias: TripAlias } | null = null;
/** Zuordnung alter trip_ids zu denen des aktuellen Fahrplans (vom nächtlichen Job, siehe src/data/alias.ts) */
export async function fvAlias(): Promise<TripAlias> {
  if (aliasCache && Date.now() - aliasCache.at < CACHE_MS) return aliasCache.alias;
  const alias = ((await staticStore().get('fv-alias', { type: 'json' })) as TripAlias | null) ?? { dates: {} };
  aliasCache = { at: Date.now(), alias };
  return alias;
}

/** Feed abrufen und Fern- und Regionalverkehr in die Tagesdateien einarbeiten. */
export async function collect(): Promise<RealtimeDay[]> {
  const [tt, rv, alias] = await Promise.all([timetable(), rvTripTiles(), fvAlias()]);
  const fvIds = new Set(tt.trips.map((t) => t.id));
  const known = (id: string) => fvIds.has(id);
  // Meldungen unter alten IDs (nach einem Fahrplanwechsel) gehören auch zum Fernverkehr
  const anyAlias: TripAlias['dates'][string] = Object.assign({}, ...Object.values(alias.dates));
  const { feedTime, groups } = extractGroups(await fetchFeed(), (id) => (fvIds.has(id) || (anyAlias[id] && fvIds.has(anyAlias[id][0])) ? 'fv' : rv?.map[id] ? 'rv' : null));
  const s = store();
  const days: RealtimeDay[] = [];
  for (const [group, byDate] of groups) {
    for (const [date, trips] of byDate) {
      const key = group === 'fv' ? date : `rv/${date}`;
      const prevText = await s.get(key, { type: 'text' });
      if (group === 'fv') renameTrips(trips, alias.dates[date] ?? anyAlias, known);
      const day = mergeDay(prevText ? (JSON.parse(prevText) as RealtimeDay) : null, date, feedTime, trips);
      // Schon gespeicherte Fahrten unter alten IDs mitnehmen
      if (group === 'fv') renameTrips(day.trips, alias.dates[date], known);
      await s.set(key, JSON.stringify(day));
      if (group === 'fv') days.push(day);
      // Für den Überblick: nur die Fahrten dieses Feeds, je eine Zahl
      else await s.setJSON(`rv-jetzt/${date}`, { date, feedTime, ...currentDelays(trips) } satisfies OverviewDelays);
    }
  }
  return days;
}

let rvDayCache: { at: number; key: string; day: RealtimeDay } | null = null;
/** Eine Regionalkachel mit den passenden Echtzeitdaten. */
export async function regionalTile(date: string, tile: string): Promise<(RegionalTile & { rt: RealtimeDay | null }) | null> {
  const index = (await staticStore().get('rv-index', { type: 'json' })) as RegionalIndex | null;
  if (!index) return null;
  const data = (await tileStore().get(`${index.version}/${date}/${tile}`, { type: 'json' })) as RegionalTile | null;
  const base: RegionalTile = data ?? { version: index.version, date, tile, ops: [], trips: [] };
  const key = `rv/${date}`;
  if (!rvDayCache || rvDayCache.key !== key || Date.now() - rvDayCache.at > 60_000) {
    const text = await store().get(key, { type: 'text' });
    rvDayCache = text ? { at: Date.now(), key, day: JSON.parse(text) as RealtimeDay } : null;
  }
  const day = rvDayCache?.day;
  const rt: RealtimeDay | null = day ? { date, feedTime: day.feedTime, trips: Object.fromEntries(base.trips.filter((t) => day.trips[t.id]).map((t) => [t.id, day.trips[t.id]])) } : null;
  return { ...base, rt };
}

/** Überblick einer Stunde (alle Regionalfahrten um diese Zeit) aus dem nächtlichen Job */
export async function overviewChunk(date: string, hour: number): Promise<{ version: string; chunk: OverviewChunk | null } | null> {
  const index = (await staticStore().get('rv-index', { type: 'json' })) as RegionalIndex | null;
  if (!index) return null;
  const chunk = (await tileStore().get(`${index.version}/ov/${date}/${String(hour).padStart(2, '0')}`, { type: 'json' })) as OverviewChunk | null;
  return { version: index.version, chunk };
}

export async function overviewDelays(date: string): Promise<OverviewDelays | null> {
  return (await store().get(`rv-jetzt/${date}`, { type: 'json' })) as OverviewDelays | null;
}

/** Tagesverdichtung aus den gesammelten Echtzeitdaten (nur möglich, solange der Fahrplan den Tag kennt). */
export async function aggregateFor(date: string): Promise<DayAgg | null> {
  const tt = await timetable();
  if (!tt.dates.includes(date)) return null;
  const text = await store().get(date, { type: 'text' });
  if (!text) return null;
  const model = buildDayModel(tt, date);
  const day = JSON.parse(text) as RealtimeDay;
  const ids = new Set(tt.trips.map((t) => t.id));
  renameTrips(day.trips, (await fvAlias()).dates[date], (id) => ids.has(id));
  return aggregateDay(model, observedResult(model, day).result);
}

/** Abgeschlossene Tage verdichten und speichern (idempotent). */
export async function buildMissingAggregates(): Promise<string[]> {
  const today = serviceDate();
  const done = new Set((await aggStore().list({ prefix: 'day/' })).blobs.map((b) => b.key.slice(4)));
  // Ältere Verdichtungen ohne Abfahrtswerte einmal neu rechnen (für "meist +3" auf der Tafel)
  for (const key of [...done]) {
    const agg = (await aggStore().get(`day/${key}`, { type: 'json' })) as Partial<DayAgg> | null;
    if (!agg?.departures) done.delete(key);
  }
  const built: string[] = [];
  for (const { key } of (await store().list()).blobs) {
    if (!/^\d{8}$/.test(key) || key >= today || done.has(key)) continue;
    const agg = await aggregateFor(key);
    if (!agg) continue;
    await aggStore().setJSON(`day/${key}`, agg);
    built.push(key);
  }
  return built;
}

/** Alle gespeicherten Tagesverdichtungen (für Open Data). */
export async function dayAggregates(): Promise<DayAgg[]> {
  const keys = (await aggStore().list({ prefix: 'day/' })).blobs.map((b) => b.key).sort();
  return (await Promise.all(keys.map((k) => aggStore().get(k, { type: 'json' })))).filter(Boolean) as DayAgg[];
}

/** Lessons learned über die letzten Wochen; ohne abgeschlossene Tage vorläufig aus dem laufenden Tag. */
export async function insights(): Promise<Insights | null> {
  const days = (await dayAggregates()).slice(-WINDOW_DAYS);
  if (!days.length) {
    const today = await aggregateFor(serviceDate());
    if (today) days.push(today);
  }
  if (!days.length) return null;
  return findings(mergeDays(days), { reasons: mergeReasons(await reasonDays()) });
}

// --- Verspätungsgründe (IRIS) --------------------------------------------------

const reasonStore = () => getStore('reasons');
const IRIS_FCHG = 'https://iris.noncd.db.de/iris-tts/timetable/fchg/';

/** Holt die Änderungsmeldungen der wichtigsten Bahnhöfe und zählt Verspätungsgründe je Tag. */
export async function collectReasons(): Promise<{ date: string; added: number; failed: number }> {
  const date = serviceDate();
  const prev = (await reasonStore().get(date, { type: 'json' })) as ReasonDay | null;
  const day: ReasonDay = prev ?? { date, stations: {}, seen: {} };
  let added = 0, failed = 0;
  const list = irisStations as { name: string; eva: string }[];
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(
      list.slice(i, i + 8).map(async (s) => {
        try {
          const res = await fetch(IRIS_FCHG + s.eva, { headers: { 'User-Agent': 'sharemytrain.de (https://github.com/tobwil/bahnimprove)' } });
          if (!res.ok) throw new Error(String(res.status));
          added += addMessages(day, s.name, parseIrisMessages(await res.text()));
        } catch {
          failed++;
        }
      }),
    );
  }
  await reasonStore().setJSON(date, day);
  return { date, added, failed };
}

export async function reasonDays(): Promise<ReasonDay[]> {
  const keys = (await reasonStore().list()).blobs.map((b) => b.key).sort().slice(-WINDOW_DAYS);
  return (await Promise.all(keys.map((k) => reasonStore().get(k, { type: 'json' })))).filter(Boolean) as ReasonDay[];
}

// --- Live mitfahren ------------------------------------------------------------

let modelCache: { date: string; version?: string; model: DayModel } | null = null;
let fvRtCache: { at: number; date: string; day: RealtimeDay | null } | null = null;

/** Eine einzelne Fahrt mit Ist-Zeiten (Fern- oder Regionalverkehr) – für geteilte Zugfahrten. */
export async function tripWithRealtime(date: string, gtfsId: string, tileHint?: string): Promise<{ stations: TimetableStation[]; trip: Trip; result: TripResult } | null> {
  const tt = await timetable();
  const midnight = berlinMidnightEpoch(date);
  if (tt.dates.includes(date)) {
    if (!modelCache || modelCache.date !== date || modelCache.version !== tt.version) modelCache = { date, version: tt.version, model: buildDayModel(tt, date) };
    const T = modelCache.model.trips.find((t) => t.gtfsId === gtfsId);
    if (T) {
      if (!fvRtCache || fvRtCache.date !== date || Date.now() - fvRtCache.at > 60_000) {
        const text = await store().get(date, { type: 'text' });
        fvRtCache = { at: Date.now(), date, day: text ? (JSON.parse(text) as RealtimeDay) : null };
      }
      return { stations: tt.stations, trip: T, result: observeTrip(T, fvRtCache.day?.trips[gtfsId], midnight) };
    }
  }
  // Regionalverkehr: Kachel aus dem Link oder aus der Zuordnung des nächtlichen Jobs
  const tiles = tileHint && /^-?\d+_-?\d+$/.test(tileHint) ? [tileHint] : ((await rvTripTiles())?.map[gtfsId] ?? []);
  for (const key of tiles.slice(0, 3)) {
    const tile = await regionalTile(date, key);
    const t = tile?.trips.find((x) => x.id === gtfsId);
    if (!tile || !t) continue;
    const line = t.line.replace(/^(RE|RB|S|IRE|MEX|ALX|FEX|IC)(\d)/, '$1 $2');
    const T: Trip = {
      id: 0,
      gtfsId,
      seqs: t.seqs ?? t.stops.map((_, i) => i),
      line,
      category: /^\d+$/.test(t.line) ? 'RB' : categoryOf(line),
      operator: tile.ops[t.op] ?? '',
      stops: t.stops,
      schedArr: t.stops.map((_, i) => t.times[i * 2]),
      schedDep: t.stops.map((_, i) => t.times[i * 2 + 1]),
    };
    return { stations: tt.stations, trip: T, result: observeTrip(T, tile.rt?.trips[gtfsId], midnight) };
  }
  return null;
}

/** Minute im Verkehrstag `date` für einen Zeitpunkt (über Mitternacht > 1440). */
export function minuteOfServiceDay(date: string, now = Date.now()): number {
  return (now / 1000 - berlinMidnightEpoch(date)) / 60;
}
