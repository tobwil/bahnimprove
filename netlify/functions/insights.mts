import type { Config } from '@netlify/functions';
import { insights } from '../realtime-store.mts';

/** GET /api/insights – Lessons learned aus den gesammelten Ist-Daten. */
export default async () => {
  const data = await insights();
  if (!data) return Response.json({ error: 'Noch keine Daten gesammelt' }, { status: 404, headers: { 'Netlify-CDN-Cache-Control': 'public, s-maxage=300' } });
  return Response.json(data, { headers: { 'Cache-Control': 'public, max-age=300', 'Netlify-CDN-Cache-Control': `public, s-maxage=${data.preliminary ? 600 : 3600}` } });
};

export const config: Config = { path: '/api/insights' };
