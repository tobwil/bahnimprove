import { getStore } from '@netlify/blobs';
import bundledTimetable from '../public/data/timetable.json' with { type: 'json' };
import irisStations from '../public/data/iris-stations.json' with { type: 'json' };
import { addMessages, mergeReasons, parseIrisMessages, type ReasonDay } from '../src/insights/reasons.ts';
import type { RegionalIndex, RegionalTile } from '../src/data/regional.ts';
import { aggregateDay, findings, mergeDays, type DayAgg, type Insights } from '../src/insights/aggregate.ts';
import { extractGroups, fetchFeed } from '../src/realtime/feed.ts';
import { mergeDay, type RealtimeDay } from '../src/realtime/types.ts';
import { buildDayModel } from '../src/sim/model.ts';
import { observedResult } from '../src/sim/real.ts';
import type { Timetable } from '../src/sim/types.ts';

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

/** Feed abrufen und Fern- und Regionalverkehr in die Tagesdateien einarbeiten. */
export async function collect(): Promise<RealtimeDay[]> {
  const [tt, rv] = await Promise.all([timetable(), rvTripTiles()]);
  const fvIds = new Set(tt.trips.map((t) => t.id));
  const { feedTime, groups } = extractGroups(await fetchFeed(), (id) => (fvIds.has(id) ? 'fv' : rv?.map[id] ? 'rv' : null));
  const s = store();
  const days: RealtimeDay[] = [];
  for (const [group, byDate] of groups) {
    for (const [date, trips] of byDate) {
      const key = group === 'fv' ? date : `rv/${date}`;
      const prevText = await s.get(key, { type: 'text' });
      const day = mergeDay(prevText ? (JSON.parse(prevText) as RealtimeDay) : null, date, feedTime, trips);
      await s.set(key, JSON.stringify(day));
      if (group === 'fv') days.push(day);
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

/** Tagesverdichtung aus den gesammelten Echtzeitdaten (nur möglich, solange der Fahrplan den Tag kennt). */
export async function aggregateFor(date: string): Promise<DayAgg | null> {
  const tt = await timetable();
  if (!tt.dates.includes(date)) return null;
  const text = await store().get(date, { type: 'text' });
  if (!text) return null;
  const model = buildDayModel(tt, date);
  return aggregateDay(model, observedResult(model, JSON.parse(text) as RealtimeDay).result);
}

/** Abgeschlossene Tage verdichten und speichern (idempotent). */
export async function buildMissingAggregates(): Promise<string[]> {
  const today = serviceDate();
  const done = new Set((await aggStore().list({ prefix: 'day/' })).blobs.map((b) => b.key.slice(4)));
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
          const res = await fetch(IRIS_FCHG + s.eva, { headers: { 'User-Agent': 'bahnimprove (https://github.com/tobwil/bahnimprove)' } });
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
