import { getStore } from '@netlify/blobs';
import timetable from '../public/data/timetable.json' with { type: 'json' };
import { extractTrips, fetchFeed } from '../src/realtime/feed.ts';
import { mergeDay, type RealtimeDay } from '../src/realtime/types.ts';

const tripIds = new Set((timetable as { trips: { id: string }[] }).trips.map((t) => t.id));

export const store = () => getStore('realtime');

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
