import { describe, expect, it } from 'vitest';
import { overviewSlice, type OverviewChunk } from '../src/data/regional.ts';
import { OverviewLayer } from '../src/regional/overview.ts';
import { currentDelays } from '../src/realtime/types.ts';

const stations = [
  { name: 'A', lat: 50, lon: 10, weight: 0 },
  { name: 'B', lat: 50, lon: 11, weight: 0 },
  { name: 'C', lat: 51, lon: 11, weight: 0 },
];
// A 9:00 → B an 9:20, ab 9:22 → C an 9:42
const times = [540, 540, 560, 562, 582, 582];

function layerWith(chunk: OverviewChunk) {
  const layer = new OverviewLayer(stations, chunk.date, 'v1');
  (layer as unknown as { chunks: Map<number, OverviewChunk> }).chunks.set(chunk.hour, chunk);
  return layer;
}

describe('Überblick der Regionalzüge', () => {
  it('schneidet eine Fahrt auf das Zeitfenster zu (mit je einem Halt davor und danach)', () => {
    expect(overviewSlice(times, 480, 600)).toEqual([0, 2]);
    expect(overviewSlice(times, 565, 570)).toEqual([1, 2]);
    expect(overviewSlice(times, 600, 660)).toBeNull();
  });

  it('setzt Züge zwischen die Halte und am Halt auf den Bahnhof', () => {
    const layer = layerWith({ version: 'v1', date: '20261020', hour: 9, trips: [['R1', 0, [0, 1, 2], times]] });
    const all = () => true;
    expect(layer.points(550, false, all)).toEqual([10.5, 50, -1]);
    expect(layer.points(561, false, all)).toEqual([11, 50, -1]);
    expect(layer.points(530 + 60, false, all)).toEqual([]); // nach Ankunft in C
    // Live mit +10: steht dort, wo er laut Fahrplan vor 10 Minuten war
    (layer as unknown as { delays: unknown }).delays = { date: '20261020', feedTime: 0, d: { R1: 10 }, x: [] };
    expect(layer.points(560, true, all)).toEqual([10.5, 50, 10]);
    // Filter der Karte (z. B. schon als Kachel geladen)
    expect(layer.points(550, false, () => false)).toEqual([]);
  });

  it('liest je Fahrt die erste gemeldete Verspätung, Ausfälle getrennt', () => {
    expect(
      currentDelays({
        a: { seen: 1, u: [[5, null, 3, 0], [3, 4.4, null, 0]] },
        b: { seen: 1, canceled: 1, u: [] },
        c: { seen: 1, u: [[2, null, null, 1], [4, 7, 7, 0]] },
      }),
    ).toEqual({ d: { a: 4, c: 7 }, x: ['b'] });
  });
});
