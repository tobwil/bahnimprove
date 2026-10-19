import type { Config } from '@netlify/functions';
import { dayAggregates, reasonDays } from '../realtime-store.mts';

/**
 * GET /api/open-data – Index der verfügbaren Tage
 * GET /api/open-data?date=YYYYMMDD – verdichtete Tageswerte und gemeldete Gründe dieses Tags
 * Lizenz: CC BY-SA 4.0 (abgeleitet aus der Echtzeit von gtfs.de, CC BY-SA 4.0), Quelle: Share my Train (sharemytrain.de), Daten: DELFI e.V./gtfs.de, Deutsche Bahn
 */
export default async (req: Request) => {
  const date = new URL(req.url).searchParams.get('date');
  const [aggs, reasons] = await Promise.all([dayAggregates(), reasonDays()]);
  const headers = { 'Cache-Control': 'public, max-age=600', 'Netlify-CDN-Cache-Control': 'public, s-maxage=3600' };
  const license = 'CC BY-SA 4.0 – Share my Train (sharemytrain.de), Daten: DELFI e.V./gtfs.de (Fahrplan CC BY 4.0, Echtzeit CC BY-SA 4.0), Deutsche Bahn (IRIS)';
  if (!date) return Response.json({ license, days: aggs.map((a) => a.date), reasons: reasons.map((r) => r.date) }, { headers });
  const agg = aggs.find((a) => a.date === date) ?? null;
  const r = reasons.find((x) => x.date === date);
  if (!agg && !r) return Response.json({ error: `Keine Daten für ${date}` }, { status: 404, headers });
  return Response.json({ license, date, aggregate: agg, reasons: r ? { date: r.date, stations: r.stations } : null }, { headers });
};

export const config: Config = { path: '/api/open-data' };
