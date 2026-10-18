import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dailyReport, metrics } from '../src/sim/analysis.ts';
import { buildDayModel } from '../src/sim/model.ts';
import { observedResult } from '../src/sim/real.ts';
import { mergeDay, type RealtimeDay } from '../src/realtime/types.ts';
import type { Timetable } from '../src/sim/types.ts';

const tt = JSON.parse(readFileSync(new URL('../public/data/timetable.json', import.meta.url), 'utf8')) as Timetable;
const date = tt.dates[1];
const m = buildDayModel(tt, date);
const trip = m.trips.find((t) => t.stops.length >= 6)!;

describe('mergeDay', () => {
  it('behält ältere Halte und überschreibt neuere Werte', () => {
    const a = mergeDay(null, date, 100, { x: { seen: 100, u: [[0, null, 2, 0], [1, 3, 3, 0]] } });
    const b = mergeDay(a, date, 200, { x: { seen: 200, u: [[1, 5, 6, 0], [2, 7, 7, 0]] } });
    expect(b.trips.x.u).toEqual([[0, null, 2, 0], [1, 5, 6, 0], [2, 7, 7, 0]]);
    expect(b.feedTime).toBe(200);
    expect(mergeDay(b, date, 150, { x: { seen: 150, u: [[1, 0, 0, 0]] } }).trips.x.u[1]).toEqual([1, 5, 6, 0]);
  });
});

describe('observedResult', () => {
  const rt: RealtimeDay = {
    date,
    feedTime: 1,
    trips: { [trip.gtfsId]: { seen: 1, u: [[trip.seqs[0], null, 4, 0], [trip.seqs[2], 10, 11, 0]] } },
  };
  const { result, stats } = observedResult(m, rt);
  const R = result.trips[trip.id];

  it('übernimmt gemeldete und fortgeschriebene Verspätungen', () => {
    expect(stats.known).toBe(1);
    expect(R.known).toBe(true);
    expect(R.dep[0] - trip.schedDep[0]).toBe(4);
    expect(R.arr[2] - trip.schedArr[2]).toBe(10);
    // Halte nach der letzten Meldung behalten die Verspätung
    expect(R.arr[4] - trip.schedArr[4]).toBeCloseTo(11, 5);
  });

  it('zählt nur Fahrten mit Daten', () => {
    expect(result.trips.filter((t) => t.known === false).length).toBe(m.trips.length - 1);
    expect(metrics(m, result).arrivals).toBeLessThanOrEqual(trip.stops.length - 1);
  });

  it('Tagesbericht auf echten Daten startet bei den beobachteten Werten', () => {
    const rep = dailyReport(m, { observed: result, candidates: 4 });
    expect(rep.mode).toBe('real');
    expect(rep.base.arrivals).toBe(metrics(m, result).arrivals);
    expect(rep.plans.passengers.metrics.passengerDelayMinutes).toBeLessThanOrEqual(rep.base.passengerDelayMinutes + 1e-6);
  });
});
