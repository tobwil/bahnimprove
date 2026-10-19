import type { Config } from '@netlify/functions';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { minuteOfServiceDay, tripWithRealtime } from '../realtime-store.mts';
import { boardIndexOf, cleanName, followHeadline, followStatus, isPain, targetIndexOf } from '../../src/share/status.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * /zug/YYYYMMDD/GTFS-ID?bis=…&von=…&k=… – geteilte Zugfahrt. Liefert die App mit passender
 * Messenger-Vorschau (Titel, Text, Pixel-Karte); die App selbst folgt dann dem Zug live.
 */
let shellCache: { html: string; source: string } | null = null;

/** Notfall-Seite: leitet zur App weiter, die dem Zug dann über ?folge= folgt */
const fallbackShell = (url: URL) => `<!doctype html><html lang="de"><head><meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Share my Train</title>
    <meta name="description" content="" />
    <script>location.replace('/?folge=' + encodeURIComponent(${JSON.stringify(url.pathname + url.search)}));</script>
  </head><body style="background:#070a14;color:#e9eefc;font-family:system-ui"><p><a href="/" style="color:#ffc56b">Share my Train öffnen</a></p></body></html>`;

/**
 * Die App-Seite (index.html): zuerst aus den mitgelieferten Dateien, dann über die interne
 * Deploy-Adresse (nicht über Cloudflare/eigene Domain), zuletzt über die aufgerufene Domain.
 */
async function appShell(url: URL): Promise<{ html: string; source: string }> {
  if (shellCache) return shellCache;
  for (const file of [join(process.cwd(), 'dist/index.html'), '/var/task/dist/index.html']) {
    try {
      const html = readFileSync(file, 'utf8');
      if (html.includes('<html')) return (shellCache = { html, source: 'file' });
    } catch {
      // nächster Weg
    }
  }
  const bases = [process.env.DEPLOY_URL, process.env.URL, url.origin].filter(Boolean) as string[];
  for (const base of bases) {
    try {
      const res = await fetch(new URL('/index.html', base), { signal: AbortSignal.timeout(4000) });
      const html = await res.text();
      if (res.ok && html.includes('<html')) return { html, source: base === url.origin ? 'origin' : 'deploy' };
    } catch {
      // nächster Weg
    }
  }
  return { html: fallbackShell(url), source: 'fallback' };
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const { html, source } = await appShell(url);
  const m = url.pathname.match(/^\/zug\/(\d{8})\/([^/]+)\/?$/);
  if (!m) return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const [, date, rawId] = m;
  // Angehängter Text aus Messengern gehört nicht zur Zug-ID
  const id = decodeURIComponent(rawId).split(/\s/)[0].slice(0, 80);
  const who = cleanName(url.searchParams.get('von'));
  let title = 'Share my Train';
  let description = 'Wo der Zug gerade ist und wann er ankommt, live aus den Echtzeitdaten.';
  try {
    const found = await tripWithRealtime(date, id, url.searchParams.get('k') ?? undefined);
    if (found) {
      const st = followStatus(found.stations, found.trip, found.result, targetIndexOf(found.stations, found.trip, url.searchParams.get('bis')), minuteOfServiceDay(date), boardIndexOf(found.stations, found.trip, url.searchParams.get('ab')));
      const pain = st.known && isPain(st.delay, st.state === 'canceled');
      title = `${pain ? 'Train Pain: ' : ''}${who ? `${who} im ` : ''}${st.line} nach ${st.target}${pain && st.state !== 'canceled' ? ` (+${st.delay} Min)` : ''}`;
      description = `${followHeadline(st, who || undefined)}. Live verfolgen: wo der Zug gerade ist.`;
    }
  } catch {
    // Vorschau ohne Zugdaten
  }
  const img = new URL('/api/zugkarte', url);
  img.searchParams.set('d', date);
  img.searchParams.set('t', id);
  for (const k of ['ab', 'bis', 'von', 'k']) {
    const v = url.searchParams.get(k);
    if (v) img.searchParams.set(k, v);
  }
  // Messenger speichern Vorschaubilder; alle 5 Minuten eine neue Adresse
  img.searchParams.set('s', String(Math.floor(Date.now() / 300_000)));
  const meta = `<meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Share my Train" />
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
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      // Notfall-Seite nicht im CDN festhalten
      'Netlify-CDN-Cache-Control': source === 'fallback' ? 'no-store' : 'public, s-maxage=60',
      'X-Shell-Source': source,
    },
  });
};

export const config: Config = { path: '/zug/*' };
