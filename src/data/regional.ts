/** Regionalverkehr (RE, RB, S-Bahn) in Kacheln von 0,5° × 0,75° (ca. 55 × 52 km). */
export const GRID = { lat0: 46.5, lon0: 5.0, dLat: 0.5, dLon: 0.75 };

export function tileKey(lat: number, lon: number): string {
  return `${Math.floor((lat - GRID.lat0) / GRID.dLat)}_${Math.floor((lon - GRID.lon0) / GRID.dLon)}`;
}

/** Kacheln rund um einen Punkt (Umkreis in Kacheln). */
export function tilesAround(lat: number, lon: number, radius = 1): string[] {
  const ty = Math.floor((lat - GRID.lat0) / GRID.dLat), tx = Math.floor((lon - GRID.lon0) / GRID.dLon);
  const out: string[] = [];
  for (let y = ty - radius; y <= ty + radius; y++) for (let x = tx - radius; x <= tx + radius; x++) out.push(`${y}_${x}`);
  return out;
}

/** Kacheln, die ein Ausschnitt (lon/lat-Grenzen) berührt. */
export function tilesInBounds(b: { minLat: number; maxLat: number; minLon: number; maxLon: number }, max = 30): string[] {
  const y0 = Math.floor((b.minLat - GRID.lat0) / GRID.dLat), y1 = Math.floor((b.maxLat - GRID.lat0) / GRID.dLat);
  const x0 = Math.floor((b.minLon - GRID.lon0) / GRID.dLon), x1 = Math.floor((b.maxLon - GRID.lon0) / GRID.dLon);
  if ((y1 - y0 + 1) * (x1 - x0 + 1) > max) return [];
  const out: string[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(`${y}_${x}`);
  return out;
}

export interface RegionalTrip {
  id: string;
  line: string;
  /** Index in `RegionalTile.ops` */
  op: number;
  stops: number[];
  times: number[];
  seqs?: number[];
}

export interface RegionalTile {
  version: string;
  date: string;
  tile: string;
  ops: string[];
  trips: RegionalTrip[];
}

/**
 * Überblick für ganz Deutschland: alle Regionalfahrten, die um eine Stunde herum unterwegs sind
 * (eine Stunde davor bis eine danach, damit auch verspätete Züge dabei sind), nur mit den Halten
 * dieses Zeitraums. Reicht, um sie im Überblick als Punkte zu zeigen, ohne alle Kacheln zu laden.
 */
export interface OverviewChunk {
  version: string;
  date: string;
  hour: number;
  /** [trip_id, 1 = S-Bahn, Bahnhöfe, Zeiten (Ankunft, Abfahrt je Halt, Minuten im Verkehrstag)] */
  trips: [string, 0 | 1, number[], number[]][];
}

/** Aktuelle Verspätung je Regionalfahrt aus dem letzten Feed (für den Überblick) */
export interface OverviewDelays {
  date: string;
  feedTime: number;
  /** trip_id → Minuten */
  d: Record<string, number>;
  /** ausgefallene Fahrten */
  x: string[];
}

/** Halte einer Fahrt, die ins Fenster [from, to] fallen – plus je einer davor und danach */
export function overviewSlice(times: number[], from: number, to: number): [number, number] | null {
  const n = times.length / 2;
  if (times[1] > to || times[(n - 1) * 2] < from) return null;
  let lo = 0;
  while (lo + 1 < n && times[(lo + 1) * 2 + 1] <= from) lo++;
  let hi = n - 1;
  while (hi - 1 > lo && times[(hi - 1) * 2] >= to) hi--;
  return [lo, hi];
}

export interface RegionalIndex {
  version: string;
  dates: string[];
  /** Kachel → Fahrten je Tag */
  tiles: Record<string, number[]>;
  /** Linie ("re19") → Kacheln, in denen ihre Fahrten beginnen – damit die Suche sie überall findet */
  lines?: Record<string, string[]>;
}
