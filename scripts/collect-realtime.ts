/**
 * Echtzeitdaten lokal sammeln (für Entwicklung und Schnappschüsse):
 *
 *   npm run realtime            # einmal abrufen
 *   npm run realtime -- --watch # alle 2 Minuten, den ganzen Tag
 *
 * Schreibt public/data/realtime/YYYYMMDD.json – dieselbe Struktur liefert in Produktion /api/realtime.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extractTrips, fetchFeed } from '../src/realtime/feed.ts';
import { mergeDay, type RealtimeDay } from '../src/realtime/types.ts';
import type { Timetable } from '../src/sim/types.ts';

const DIR = 'public/data/realtime';
const INTERVAL = 120_000;

async function collect(ids: Set<string>) {
  const { feedTime, byDate } = extractTrips(await fetchFeed(), ids);
  mkdirSync(DIR, { recursive: true });
  for (const [date, trips] of byDate) {
    const file = `${DIR}/${date}.json`;
    const prev = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RealtimeDay) : null;
    const day = mergeDay(prev, date, feedTime, trips);
    writeFileSync(file, JSON.stringify(day));
    console.log(`${new Date(feedTime * 1000).toISOString()} ${file}: ${Object.keys(trips).length} Fahrten im Feed, ${Object.keys(day.trips).length} gesammelt`);
  }
}

const tt = JSON.parse(readFileSync('public/data/timetable.json', 'utf8')) as Timetable;
const ids = new Set(tt.trips.map((t) => t.id));
await collect(ids);
if (process.argv.includes('--watch')) {
  setInterval(() => collect(ids).catch((e) => console.error(e)), INTERVAL);
}
