/**
 * Lädt die freien GTFS-Feeds von gtfs.de (Daten: DELFI e.V., CC BY 4.0) und erzeugt
 *   public/data/timetable.json        Fernverkehr + alle Bahnhöfe (wird eingecheckt)
 *   public/data/rv/…                  Regionalverkehr in Kacheln (nur lokal; in Produktion aus Netlify Blobs)
 *
 *   npm run data              # beide Feeds neu laden
 *   RV=0 npm run data         # nur Fernverkehr
 *   START_DATE=20261020 …     # anderer Starttag (Standard: gestern)
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { FV_URL, RV_URL, addDays, berlinToday, buildStatic, unzipFeed } from '../src/data/gtfs.ts';

/** Gestern (für den Tagesbericht) plus zwei Wochen voraus. */
const FV_DAYS = 15;
/** Regionalverkehr: gestern bis übermorgen. */
const RV_DAYS = 4;

async function download(url: string): Promise<Uint8Array> {
  console.log(`Lade ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function main() {
  const start = process.env.START_DATE ?? addDays(berlinToday(), -1);
  const withRv = process.env.RV !== '0';
  const [fvZip, rvZip] = await Promise.all([download(FV_URL), withRv ? download(RV_URL) : Promise.resolve(null)]);
  const t0 = performance.now();
  const build = buildStatic(unzipFeed(fvZip), rvZip ? unzipFeed(rvZip) : null, { start, fvDays: FV_DAYS, rvDays: RV_DAYS });
  const tt = build.timetable;
  mkdirSync('public/data', { recursive: true });
  writeFileSync('public/data/timetable.json', JSON.stringify(tt));
  const served = tt.stations.filter((s) => (s.w ?? 0) > 0).length;
  console.log(`timetable.json: ${tt.stations.length} Bahnhöfe (${served} bedient), ${tt.trips.length} Fernverkehrsfahrten, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  if (build.regional) {
    rmSync('public/data/rv', { recursive: true, force: true });
    for (const [key, tile] of build.regional.tiles) {
      mkdirSync(`public/data/rv/${key.split('/')[0]}`, { recursive: true });
      writeFileSync(`public/data/rv/${key}.json`, JSON.stringify(tile));
    }
    writeFileSync('public/data/rv/index.json', JSON.stringify(build.regional.index));
    writeFileSync('public/data/rv/trip-tiles.json', JSON.stringify(build.regional.tripTiles));
    const perDay = build.regional.index.dates.map((d, i) => `${d}:${Object.values(build.regional!.index.tiles).reduce((s, c) => s + c[i], 0)}`);
    console.log(`rv/: ${build.regional.tiles.size} Kacheln, Fahrten je Kachel und Tag: ${perDay.join(' ')}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
