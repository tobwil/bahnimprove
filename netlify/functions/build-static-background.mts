import type { Context } from '@netlify/functions';
import { FV_URL, RV_URL, addDays, berlinToday, buildStatic, unzipFeed } from '../../src/data/gtfs.ts';
import { staticStore, tileStore } from '../realtime-store.mts';

/**
 * Nächtlicher Fahrplan-Job (Hintergrund, bis 15 Min): lädt die GTFS-Feeds von gtfs.de und legt
 * Fernverkehrsfahrplan, Bahnhöfe und Regionalkacheln in Netlify Blobs ab.
 * Wird von refresh-static ausgelöst; geschützt über STATIC_BUILD_SECRET.
 */
export default async (req: Request, _context: Context) => {
  const secret = Netlify.env.get('STATIC_BUILD_SECRET');
  if (!secret || req.headers.get('x-build-secret') !== secret) return new Response('Nicht erlaubt', { status: 401 });
  const download = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const [fv, rv] = await Promise.all([download(FV_URL), download(RV_URL)]);
  const version = new Date().toISOString();
  const build = buildStatic(unzipFeed(fv), unzipFeed(rv), { start: addDays(berlinToday(), -1), fvDays: 15, rvDays: 4, version });
  const tiles = tileStore();
  const entries = [...build.regional!.tiles.entries()];
  for (let i = 0; i < entries.length; i += 20) {
    await Promise.all(entries.slice(i, i + 20).map(([key, tile]) => tiles.setJSON(`${version}/${key}`, tile)));
  }
  // Erst wenn alle Kacheln liegen, zeigen Index und Fahrplan auf die neue Version
  const st = staticStore();
  await st.setJSON('rv-trip-tiles', { version, map: build.regional!.tripTiles });
  await st.setJSON('rv-index', build.regional!.index);
  await st.set('timetable', JSON.stringify(build.timetable));
  // Alte Kachel-Versionen aufräumen
  const old = (await tiles.list()).blobs.filter((b) => !b.key.startsWith(`${version}/`));
  for (let i = 0; i < old.length; i += 50) await Promise.all(old.slice(i, i + 50).map((b) => tiles.delete(b.key)));
  console.log(`Fahrplan ${version}: ${build.timetable.trips.length} FV-Fahrten, ${entries.length} Kacheln, ${old.length} alte gelöscht`);
};

export const config = { background: true };
