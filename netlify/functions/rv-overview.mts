import type { Config } from '@netlify/functions';
import { overviewChunk, overviewDelays } from '../realtime-store.mts';

/**
 * Überblick über alle Regionalzüge (für die Deutschlandkarte, bevor Kacheln geladen sind):
 * GET /api/rv-ueberblick?date=YYYYMMDD&h=HH&v=VERSION – Fahrten dieser Stunde (ändert sich nur nachts)
 * GET /api/rv-jetzt?date=YYYYMMDD – aktuelle Verspätung je Fahrt (alle 2 Minuten neu)
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  const q = url.searchParams;
  const date = q.get('date') ?? '';
  if (!/^\d{8}$/.test(date)) return Response.json({ error: 'date nötig' }, { status: 400 });

  if (url.pathname.endsWith('/rv-jetzt')) {
    const delays = await overviewDelays(date);
    if (!delays) return Response.json({ error: 'Keine Echtzeit' }, { status: 404, headers: { 'Netlify-CDN-Cache-Control': 'public, s-maxage=60' } });
    return Response.json(delays, { headers: { 'Cache-Control': 'public, max-age=60', 'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } });
  }

  const h = Number(q.get('h'));
  if (!Number.isInteger(h) || h < 0 || h > 36) return Response.json({ error: 'h nötig' }, { status: 400 });
  const found = await overviewChunk(date, h);
  if (!found) return Response.json({ error: 'Regionalverkehr noch nicht aufbereitet' }, { status: 404, headers: { 'Netlify-CDN-Cache-Control': 'public, s-maxage=300' } });
  // Bahnhofsnummern gehören zu einer Fahrplanversion
  const v = q.get('v');
  if (v && v !== found.version) return Response.json({ error: 'Andere Fahrplanversion', version: found.version }, { status: 409 });
  // Vor dem ersten nächtlichen Lauf mit Überblick gibt es die Stunde noch nicht: leer, kurz zwischenspeichern
  if (!found.chunk) return Response.json({ version: found.version, date, hour: h, trips: [] }, { headers: { 'Netlify-CDN-Cache-Control': 'public, s-maxage=300' } });
  return Response.json(found.chunk, { headers: { 'Cache-Control': 'public, max-age=600', 'Netlify-CDN-Cache-Control': 'public, s-maxage=86400' } });
};

export const config: Config = { path: ['/api/rv-ueberblick', '/api/rv-jetzt'] };
