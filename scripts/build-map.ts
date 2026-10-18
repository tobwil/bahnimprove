/**
 * Erzeugt die Landesgrenzen für die Pixelkarte aus Natural Earth (world-atlas, Public Domain).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { MapData } from '../src/ui/mapdata.ts';

const URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
const BBOX = { minLon: 1.5, maxLon: 21, minLat: 44.5, maxLat: 58 };

async function main() {
  const topo = (await (await fetch(URL)).json()) as Topology<{ countries: GeometryCollection<{ name: string }> }>;
  const fc = feature(topo, topo.objects.countries);
  const countries: MapData['countries'] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const rings: [number, number][][] = [];
    for (const poly of polys) {
      for (const ring of poly) {
        if (!ring.some(([lon, lat]) => lon >= BBOX.minLon && lon <= BBOX.maxLon && lat >= BBOX.minLat && lat <= BBOX.maxLat)) continue;
        rings.push(ring.map(([lon, lat]) => [+lon.toFixed(3), +lat.toFixed(3)]));
      }
    }
    if (rings.length) countries.push({ name: f.properties?.name ?? '', germany: f.properties?.name === 'Germany', rings });
  }
  mkdirSync('public/data', { recursive: true });
  writeFileSync('public/data/map.json', JSON.stringify({ countries } satisfies MapData));
  console.log(`public/data/map.json: ${countries.length} Länder`);
}

main();
