import type { Config } from '@netlify/functions';
import { collect, serviceDate, store } from '../realtime-store.mts';

/** GET /api/realtime?date=YYYYMMDD – gesammelte Echtzeitdaten eines Verkehrstags. */
export default async (req: Request) => {
  const date = new URL(req.url).searchParams.get('date') ?? '';
  if (!/^\d{8}$/.test(date)) return Response.json({ error: 'Parameter date=YYYYMMDD fehlt' }, { status: 400 });
  let day = await store().get(date, { type: 'json' });
  // Erster Aufruf nach dem Deploy: für heute einmal direkt abrufen, statt auf den Sammler zu warten.
  if (!day && date === serviceDate()) day = (await collect()).find((d) => d.date === date) ?? null;
  if (!day) {
    return Response.json(
      { error: `Keine Echtzeitdaten für ${date}` },
      { status: 404, headers: { 'Netlify-CDN-Cache-Control': 'public, s-maxage=300' } },
    );
  }
  return Response.json(day, { headers: { 'Cache-Control': 'public, max-age=30', 'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60' } });
};

export const config: Config = { path: '/api/realtime' };
