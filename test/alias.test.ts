import { describe, expect, it } from 'vitest';
import { seqMap, tripAlias } from '../src/data/alias.ts';
import { renameTrips, type RealtimeTrip } from '../src/realtime/types.ts';
import type { Timetable, TimetableTrip } from '../src/sim/types.ts';

const stations = ['Köln Hbf', 'Berlin Hbf', 'Berlin Südkreuz', 'Essen Hbf', 'München Hbf'].map((name) => ({ name, lat: 0, lon: 0, weight: 1 }));
const trip = (id: string, route: number, stops: number[], dep: number, arr: number, days = 0b11): TimetableTrip => ({
  id, route, operator: 'DB', days, stops, times: [dep, dep, ...stops.slice(1, -1).flatMap(() => [dep + 10, dep + 11]), arr, arr],
});
const tt = (version: string, trips: TimetableTrip[]): Timetable => ({ generatedAt: '', source: '', version, dates: ['20261020', '20261021'], routes: ['ICE 10', 'IC 55'], stations, trips });

describe('Zuordnung neuer trip_ids', () => {
  const oldTt = tt('v1', [
    trip('a1', 0, [0, 1], 326, 679),
    trip('a2', 0, [3, 1], 1101, 1409), // Ziel wird im neuen Fahrplan Südkreuz (Baustelle)
    trip('a3', 1, [0, 4], 311, 770),
    trip('same', 1, [4, 0], 900, 1200), // ID bleibt gleich: braucht keine Zuordnung
  ]);
  const newTt = tt('v2', [
    trip('b1', 0, [0, 1], 326, 679),
    trip('b2', 0, [3, 2], 1101, 1415),
    trip('b3', 1, [0, 4], 311, 770, 0b10), // fährt erst am 21.
    trip('same', 1, [4, 0], 900, 1200),
  ]);

  it('findet dieselbe Fahrt über Linie, Start, Abfahrt und Ziel – auch mit geändertem Ziel', () => {
    const a = tripAlias(oldTt, newTt, ['20261020', '20261021']);
    expect(a.version).toBe('v2');
    // a2: Ziel geändert – nur der gemeinsame Halt (Essen) behält seine Meldungen
    expect(a.dates['20261020']).toEqual({ a1: ['b1'], a2: ['b2', [0, 0]] });
    expect(a.dates['20261021']).toEqual({ a1: ['b1'], a2: ['b2', [0, 0]], a3: ['b3'] });
  });

  it('nimmt nur alte IDs mit Echtzeit und vergibt jede neue Fahrt nur einmal', () => {
    const twin = tt('v1', [...oldTt.trips, trip('a1-dup', 0, [0, 1], 326, 679)]);
    expect(tripAlias(twin, newTt, ['20261020'], () => new Set(['a1-dup'])).dates['20261020']).toEqual({ 'a1-dup': ['b1'] });
    expect(Object.values(tripAlias(twin, newTt, ['20261020']).dates['20261020']).map((e) => e[0])).toEqual(['b1', 'b2']);
  });

  it('übersetzt Haltnummern über die Bahnhöfe, wenn sie sich ändern', () => {
    // alt: Essen(0) Köln(1) Berlin(2); neu mit zusätzlichem Halt und anderen Nummern: Essen(1) München(2) Köln(3) Berlin(5)
    const a = { ...trip('x', 0, [3, 0, 1], 100, 300) };
    const b = { ...trip('y', 0, [3, 4, 0, 1], 100, 300), seqs: [1, 2, 3, 5] };
    expect(seqMap(oldTt, a, newTt, b)).toEqual([0, 1, 1, 3, 2, 5]);
    expect(seqMap(oldTt, a, newTt, { ...a, id: 'z' })).toBeUndefined();
    const withSeq = tt('v2', [b]);
    expect(tripAlias(tt('v1', [a]), withSeq, ['20261020']).dates['20261020']).toEqual({ x: ['y', [0, 1, 1, 3, 2, 5]] });
  });

  it('schreibt gespeicherte Echtzeit auf die neuen IDs um und vereint doppelte Stände', () => {
    const known = (id: string) => ['b1', 'b2', 'same'].includes(id);
    const trips: Record<string, RealtimeTrip> = {
      a1: { seen: 100, u: [[0, null, 2, 0], [1, 5, null, 0]] },
      b1: { seen: 200, u: [[1, 7, null, 0]] },
      a2: { seen: 50, u: [[0, null, 1, 0]] },
      unknown: { seen: 50, u: [] },
    };
    expect(renameTrips(trips, { a1: ['b1'], a2: ['b2', [0, 4]], unknown: ['nowhere'] }, known)).toBe(2);
    expect(Object.keys(trips).sort()).toEqual(['b1', 'b2', 'unknown']);
    expect(trips.b1).toEqual({ seen: 200, u: [[0, null, 2, 0], [1, 7, null, 0]] });
    // Haltnummer 0 → 4; Halte ohne Entsprechung fallen weg
    expect(trips.b2.u).toEqual([[4, null, 1, 0]]);
    const t2: Record<string, RealtimeTrip> = { a2: { seen: 1, u: [[0, 1, 1, 0], [9, 3, 3, 0]] } };
    renameTrips(t2, { a2: ['b2', [0, 4]] }, known);
    expect(t2.b2.u).toEqual([[4, 1, 1, 0]]);
  });
});
