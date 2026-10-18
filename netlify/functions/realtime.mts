import type { Config } from '@netlify/functions';
import { collect, store } from './shared.mts';

/** GET /api/realtime?date=YYYYMMDD – gesammelte Echtzeitdaten eines Verkehrstags. */
export default async (req: Request) => {
  const date = new URL(req.url).searchParams.get('date') ?? '';
  if (!/^\d{8}$/.test(date)) return Response.json({ error: 'Parameter date=YYYYMMDD fehlt' }, { status: 400 });
  let day = await store().get(date, { type: 'json' });
  // Erster Aufruf nach dem Deploy: noch nichts gesammelt → einmal direkt abrufen.
  if (!day) day = (await collect()).find((d) => d.date === date) ?? null;
  if (!day) return Response.json({ error: `Keine Echtzeitdaten für ${date}` }, { status: 404 });
  return Response.json(day, { headers: { 'Cache-Control': 'public, max-age=30', 'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=60' } });
};

export const config: Config = { path: '/api/realtime' };
