import type { Config } from '@netlify/functions';
import { staticStore } from '../realtime-store.mts';

/** GET /api/static/timetable – aktueller Fahrplan aus dem nächtlichen Job (404 → App nutzt den mitgelieferten). */
export default async (req: Request) => {
  const name = new URL(req.url).pathname.split('/').pop();
  if (name !== 'timetable' && name !== 'rv-index' && name !== 'build-status') return new Response('Unbekannt', { status: 404 });
  const text = await staticStore().get(name, { type: 'text' });
  if (!text) return Response.json({ error: 'Noch nicht erzeugt' }, { status: 404, headers: { 'Netlify-CDN-Cache-Control': 'public, s-maxage=300' } });
  const cache = name === 'build-status' ? 'no-store' : 'public, s-maxage=1800';
  return new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': name === 'build-status' ? 'no-store' : 'public, max-age=600', 'Netlify-CDN-Cache-Control': cache } });
};

export const config: Config = { path: '/api/static/:name' };
