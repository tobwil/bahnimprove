import type { Config } from '@netlify/functions';
import { regionalTile } from '../realtime-store.mts';

/** GET /api/rv?date=YYYYMMDD&tile=Y_X&v=VERSION – Regionalzüge einer Kachel mit Echtzeitdaten. */
export default async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const date = q.get('date') ?? '', tile = q.get('tile') ?? '', v = q.get('v');
  if (!/^\d{8}$/.test(date) || !/^-?\d+_-?\d+$/.test(tile)) return Response.json({ error: 'date und tile nötig' }, { status: 400 });
  const data = await regionalTile(date, tile);
  if (!data) return Response.json({ error: 'Regionalverkehr noch nicht aufbereitet' }, { status: 404, headers: { 'Netlify-CDN-Cache-Control': 'public, s-maxage=300' } });
  // Kacheln gehören zu einer Fahrplanversion (Bahnhofsnummern)
  if (v && v !== data.version) return Response.json({ error: 'Andere Fahrplanversion', version: data.version }, { status: 409 });
  return Response.json(data, { headers: { 'Cache-Control': 'public, max-age=60', 'Netlify-CDN-Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' } });
};

export const config: Config = { path: '/api/rv' };
