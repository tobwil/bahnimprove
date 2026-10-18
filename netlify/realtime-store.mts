import { getStore } from '@netlify/blobs';
import timetableJson from '../public/data/timetable.json' with { type: 'json' };
import { aggregateDay, findings, mergeDays, type DayAgg, type Insights } from '../src/insights/aggregate.ts';
import { extractTrips, fetchFeed } from '../src/realtime/feed.ts';
import { mergeDay, type RealtimeDay } from '../src/realtime/types.ts';
import { buildDayModel } from '../src/sim/model.ts';
import { observedResult } from '../src/sim/real.ts';
import type { Timetable } from '../src/sim/types.ts';

const timetable = timetableJson as unknown as Timetable;
const tripIds = new Set(timetable.trips.map((t) => t.id));

export const store = () => getStore('realtime');
const aggStore = () => getStore('insights');

/** Wie viele Tage die Lessons learned zurückblicken. */
const WINDOW_DAYS = 28;

/** Verkehrstag (YYYYMMDD) in Berlin; bis 03:00 zählt noch der Vortag. */
export function serviceDate(now = new Date()): string {
  const berlin = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  if (berlin.getHours() < 3) berlin.setDate(berlin.getDate() - 1);
  return `${berlin.getFullYear()}${String(berlin.getMonth() + 1).padStart(2, '0')}${String(berlin.getDate()).padStart(2, '0')}`;
}

/** Feed abrufen und in die Tagesdateien im Blob-Store einarbeiten. */
export async function collect(): Promise<RealtimeDay[]> {
  const { feedTime, byDate } = extractTrips(await fetchFeed(), tripIds);
  const s = store();
  const days: RealtimeDay[] = [];
  for (const [date, trips] of byDate) {
    const prev = (await s.get(date, { type: 'json' })) as RealtimeDay | null;
    const day = mergeDay(prev, date, feedTime, trips);
    await s.setJSON(date, day);
    days.push(day);
  }
  return days;
}

/** Tagesverdichtung aus den gesammelten Echtzeitdaten (nur möglich, solange der Fahrplan den Tag kennt). */
export async function aggregateFor(date: string): Promise<DayAgg | null> {
  if (!timetable.dates.includes(date)) return null;
  const rt = (await store().get(date, { type: 'json' })) as RealtimeDay | null;
  if (!rt) return null;
  const model = buildDayModel(timetable, date);
  return aggregateDay(model, observedResult(model, rt).result);
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

/** Lessons learned über die letzten Wochen; ohne abgeschlossene Tage vorläufig aus dem laufenden Tag. */
export async function insights(): Promise<Insights | null> {
  const keys = (await aggStore().list({ prefix: 'day/' })).blobs.map((b) => b.key).sort().slice(-WINDOW_DAYS);
  const days = (await Promise.all(keys.map((k) => aggStore().get(k, { type: 'json' })))).filter(Boolean) as DayAgg[];
  if (!days.length) {
    const today = await aggregateFor(serviceDate());
    if (today) days.push(today);
  }
  return days.length ? findings(mergeDays(days)) : null;
}
