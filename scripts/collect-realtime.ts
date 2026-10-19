/**
 * Echtzeitdaten lokal sammeln (für Entwicklung und Schnappschüsse):
 *
 *   npm run realtime            # einmal abrufen
 *   npm run realtime -- --watch # alle 2 Minuten, den ganzen Tag
 *
 * Schreibt public/data/realtime/YYYYMMDD.json (Fernverkehr) und rv-YYYYMMDD.json (Regionalverkehr,
 * nur wenn public/data/rv/ per `npm run data` erzeugt wurde) – in Produktion liefern das /api/realtime und /api/rv.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extractGroups, fetchFeed } from '../src/realtime/feed.ts';
import { mergeDay, type RealtimeDay } from '../src/realtime/types.ts';
import type { Timetable } from '../src/sim/types.ts';

const DIR = 'public/data/realtime';
const INTERVAL = 120_000;

const tt = JSON.parse(readFileSync('public/data/timetable.json', 'utf8')) as Timetable;
const fvIds = new Set(tt.trips.map((t) => t.id));
const rvMap = existsSync('public/data/rv/trip-tiles.json') ? (JSON.parse(readFileSync('public/data/rv/trip-tiles.json', 'utf8')) as Record<string, string[]>) : {};

async function collect() {
  const { feedTime, groups } = extractGroups(await fetchFeed(), (id) => (fvIds.has(id) ? 'fv' : rvMap[id] ? 'rv' : null));
  mkdirSync(DIR, { recursive: true });
  for (const [group, byDate] of groups) {
    for (const [date, trips] of byDate) {
      const file = `${DIR}/${group === 'fv' ? '' : 'rv-'}${date}.json`;
      const prev = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RealtimeDay) : null;
      const day = mergeDay(prev, date, feedTime, trips);
      writeFileSync(file, JSON.stringify(day));
      console.log(`${new Date(feedTime * 1000).toISOString()} ${file}: ${Object.keys(trips).length} im Feed, ${Object.keys(day.trips).length} gesammelt`);
    }
  }
}

await collect();
if (process.argv.includes('--watch')) setInterval(() => collect().catch((e) => console.error(e)), INTERVAL);
