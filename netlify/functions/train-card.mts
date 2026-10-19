import type { Config } from '@netlify/functions';
import { deflateSync } from 'node:zlib';
import { minuteOfServiceDay, tripWithRealtime } from '../realtime-store.mts';
import { CARD_H, CARD_SCALE, CARD_W, renderCard, upscale } from '../../src/share/card.ts';
import { encodePng } from '../../src/share/png.ts';
import { boardIndexOf, cleanName, followStatus, targetIndexOf } from '../../src/share/status.ts';

/** GET /api/zugkarte?d=YYYYMMDD&t=GTFS-ID&bis=Bahnhof&von=Name&k=Kachel – Vorschaubild für geteilte Zugfahrten. */
export default async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const date = q.get('d') ?? '', id = q.get('t') ?? '';
  if (!/^\d{8}$/.test(date) || !id || id.length > 80) return new Response('d und t nötig', { status: 400 });
  const found = await tripWithRealtime(date, id, q.get('k') ?? undefined);
  if (!found) return new Response('Fahrt nicht gefunden', { status: 404 });
  const now = minuteOfServiceDay(date);
  const st = followStatus(found.stations, found.trip, found.result, targetIndexOf(found.stations, found.trip, q.get('bis')), now, boardIndexOf(found.stations, found.trip, q.get('ab')));
  const pixels = renderCard(st, { name: cleanName(q.get('von')), stamp: now });
  const png = encodePng(CARD_W * CARD_SCALE, CARD_H * CARD_SCALE, upscale(pixels, CARD_W, CARD_H, CARD_SCALE), (d) => deflateSync(d, { level: 9 }));
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60', 'Netlify-CDN-Cache-Control': 'public, s-maxage=120' },
  });
};

export const config: Config = { path: '/api/zugkarte' };
