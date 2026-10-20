import type { Context } from '@netlify/functions';
import { FV_URL, RV_URL, addDays, berlinToday, buildStatic, unzipFeed } from '../../src/data/gtfs.ts';
import { staticStore, tileStore } from '../realtime-store.mts';

/**
 * Nächtlicher Fahrplan-Job (Hintergrund, bis 15 Min): lädt die GTFS-Feeds von gtfs.de und legt
 * Fernverkehrsfahrplan, Bahnhöfe und Regionalkacheln in Netlify Blobs ab.
 * Wird von refresh-static ausgelöst; geschützt über STATIC_BUILD_SECRET.
 * Fortschritt und Fehler stehen unter /api/static/build-status.
 */
export default async (req: Request, _context: Context) => {
  const secret = Netlify.env.get('STATIC_BUILD_SECRET');
  if (!secret || req.headers.get('x-build-secret') !== secret) return;
  const st = staticStore();
  const status = (step: string, extra: Record<string, unknown> = {}) => st.setJSON('build-status', { step, at: new Date().toISOString(), ...extra });
  try {
    await status('download');
    const download = async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    };
    const [fv, rv] = await Promise.all([download(FV_URL), download(RV_URL)]);
    await status('build', { bytes: fv.length + rv.length });
    const version = new Date().toISOString();
    const build = buildStatic(unzipFeed(fv), unzipFeed(rv), { start: addDays(berlinToday(), -1), fvDays: 15, rvDays: 4, version });
    const tiles = tileStore();
    const entries = [...build.regional!.tiles.entries(), ...[...build.regional!.overview.entries()].map(([k, c]) => [`ov/${k}`, c] as const)];
    await status('upload', { tiles: entries.length });
    for (let i = 0; i < entries.length; i += 20) {
      await Promise.all(entries.slice(i, i + 20).map(([key, tile]) => tiles.set(`${version}/${key}`, JSON.stringify(tile))));
    }
    // Erst wenn alle Kacheln liegen, zeigen Index und Fahrplan auf die neue Version
    await st.set('rv-trip-tiles', JSON.stringify({ version, map: build.regional!.tripTiles }));
    await st.set('rv-index', JSON.stringify(build.regional!.index));
    await st.set('timetable', JSON.stringify(build.timetable));
    // Alte Kachel-Versionen aufräumen
    const old = (await tiles.list()).blobs.filter((b) => !b.key.startsWith(`${version}/`));
    for (let i = 0; i < old.length; i += 50) await Promise.all(old.slice(i, i + 50).map((b) => tiles.delete(b.key)));
    await status('done', { version, fvTrips: build.timetable.trips.length, tiles: entries.length, deleted: old.length });
  } catch (e) {
    await status('error', { message: String(e), stack: e instanceof Error ? e.stack : undefined });
    throw e;
  }
};

export const config = { background: true };
