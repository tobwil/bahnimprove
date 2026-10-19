import type { Config } from '@netlify/functions';
import { minuteOfServiceDay, tripWithRealtime } from '../realtime-store.mts';
import { cleanName, followHeadline, followStatus, targetIndexOf } from '../../src/share/status.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * /zug/YYYYMMDD/GTFS-ID?bis=…&von=…&k=… – geteilte Zugfahrt. Liefert die App mit passender
 * Messenger-Vorschau (Titel, Text, Pixel-Karte); die App selbst folgt dann dem Zug live.
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  const html = await (await fetch(new URL('/index.html', url))).text();
  const m = url.pathname.match(/^\/zug\/(\d{8})\/([^/]{1,80})\/?$/);
  if (!m) return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const [, date, rawId] = m;
  const id = decodeURIComponent(rawId);
  const who = cleanName(url.searchParams.get('von'));
  let title = 'Live mitfahren – Bahnimprove';
  let description = 'Wo der Zug gerade ist und wann er ankommt, live aus den Echtzeitdaten.';
  try {
    const found = await tripWithRealtime(date, id, url.searchParams.get('k') ?? undefined);
    if (found) {
      const st = followStatus(found.stations, found.trip, found.result, targetIndexOf(found.stations, found.trip, url.searchParams.get('bis')), minuteOfServiceDay(date));
      title = `${who ? `${who} im ` : ''}${st.line} nach ${st.target}`;
      description = `${followHeadline(st, who || undefined)}. Live verfolgen: wo der Zug gerade ist.`;
    }
  } catch {
    // Vorschau ohne Zugdaten
  }
  const img = new URL('/api/zugkarte', url);
  img.searchParams.set('d', date);
  img.searchParams.set('t', id);
  for (const k of ['bis', 'von', 'k']) {
    const v = url.searchParams.get(k);
    if (v) img.searchParams.set(k, v);
  }
  // Messenger speichern Vorschaubilder; alle 5 Minuten eine neue Adresse
  img.searchParams.set('s', String(Math.floor(Date.now() / 300_000)));
  const meta = `<meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${esc(url.toString())}" />
    <meta property="og:image" content="${esc(img.toString())}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="632" />
    <meta name="twitter:card" content="summary_large_image" />`;
  const out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta property="og:[^>]*>\s*/g, '')
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(description)}" />\n    ${meta}`);
  return new Response(out, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate', 'Netlify-CDN-Cache-Control': 'public, s-maxage=60' },
  });
};

export const config: Config = { path: '/zug/*' };
