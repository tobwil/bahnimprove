import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { dailyReport, metrics } from '../src/sim/analysis.ts';
import { HEADWAY, defaultPolicy, simulate } from '../src/sim/engine.ts';
import { ArrivalIndex, trainAt } from '../src/sim/live.ts';
import { buildDayModel, edgeKey, type DayModel } from '../src/sim/model.ts';
import type { SimResult, Timetable } from '../src/sim/types.ts';
import { cleanName } from '../src/data/gtfs.ts';

const tt = JSON.parse(readFileSync(new URL('../public/data/timetable.json', import.meta.url), 'utf8')) as Timetable;
const date = tt.dates[1];

let m: DayModel;
let r: SimResult;
beforeAll(() => {
  m = buildDayModel(tt, date);
  r = simulate(m, defaultPolicy());
});

describe('Simulation', () => {
  it('ist deterministisch', () => {
    const again = simulate(buildDayModel(tt, date), defaultPolicy());
    expect(again.trips.map((t) => t.arr)).toEqual(r.trips.map((t) => t.arr));
  });

  it('kein Zug fährt zu früh ab, Zeiten sind monoton', () => {
    for (const t of m.trips) {
      const R = r.trips[t.id];
      for (let i = 0; i < t.stops.length; i++) {
        expect(R.dep[i]).toBeGreaterThanOrEqual(t.schedDep[i] - 1e-9);
        expect(R.dep[i]).toBeGreaterThanOrEqual(R.arr[i] - 1e-9);
        if (i > 0) expect(R.arr[i]).toBeGreaterThan(R.dep[i - 1]);
      }
    }
  });

  it('hält die Mindestzugfolge je Abschnitt ein', () => {
    const deps = new Map<number, number[]>();
    for (const t of m.trips) {
      for (let i = 0; i + 1 < t.stops.length; i++) {
        const k = edgeKey(t.stops[i], t.stops[i + 1]);
        (deps.get(k) ?? deps.set(k, []).get(k)!).push(r.trips[t.id].dep[i]);
      }
    }
    for (const list of deps.values()) {
      list.sort((a, b) => a - b);
      for (let i = 1; i < list.length; i++) expect(list[i] - list[i - 1]).toBeGreaterThanOrEqual(HEADWAY - 1e-6);
    }
  });

  it('liefert eine realistische Pünktlichkeit', () => {
    const mm = metrics(m, r);
    expect(mm.punctuality).toBeGreaterThan(0.5);
    expect(mm.punctuality).toBeLessThan(0.95);
  });

  it('Anschluss halten verhindert den verpassten Anschluss', () => {
    const i = r.connectionOutcome.findIndex((o, idx) => {
      const c = m.connections[idx];
      return o === 'missed' && r.trips[c.feeder].arr[c.feederStop] + 3 - m.trips[c.departing].schedDep[c.departingStop] < 15;
    });
    expect(i).toBeGreaterThanOrEqual(0);
    const p = defaultPolicy();
    p.connectionOverride.set(i, 'hold');
    expect(simulate(m, p).connectionOutcome[i]).not.toBe('missed');
  });
});

describe('Live-Zustand', () => {
  it('Positionen liegen zwischen zwei Halten', () => {
    const t = m.trips.find((x) => x.stops.length > 4)!;
    const R = r.trips[t.id];
    const mid = (R.dep[1] + R.arr[2]) / 2;
    const s = trainAt(m, r, t.id, mid)!;
    expect(s.stop).toBe(1);
    expect(s.atStation).toBe(false);
    expect(s.progress).toBeGreaterThan(0);
    expect(s.progress).toBeLessThan(1);
    expect(trainAt(m, r, t.id, R.dep[0] - 30)).toBeNull();
  });

  it('Pünktlichkeit bis Tagesende entspricht der Tagesbilanz', () => {
    const idx = new ArrivalIndex(m, r);
    expect(idx.until(1e9).punctuality).toBeCloseTo(metrics(m, r).punctuality, 10);
  });
});

describe('Tagesbericht', () => {
  it('Pläne verschlechtern ihr Ziel nie', () => {
    const rep = dailyReport(m, { candidates: 8 });
    expect(rep.plans.passengers.metrics.passengerDelayMinutes).toBeLessThanOrEqual(rep.base.passengerDelayMinutes);
    expect(rep.plans.punctuality.metrics.punctual).toBeGreaterThanOrEqual(rep.base.punctual);
    for (const s of rep.suggestions) expect(s.savedPassengerMinutes > 50 || s.punctualityDelta > 0).toBe(true);
  });
});

describe('Haltestellennamen', () => {
  it('vereinheitlicht GTFS-Namen', () => {
    expect(cleanName('S+U Berlin Hauptbahnhof', 52.5, 13.4)).toBe('Berlin Hbf');
    expect(cleanName('S Südkreuz Bhf (Berlin)', 52.5, 13.4)).toBe('Berlin Südkreuz');
    expect(cleanName('Mannheim, Hauptbahnhof', 49.5, 8.5)).toBe('Mannheim Hbf');
    expect(cleanName('Hamburg, Hamburg-Harburg', 53.5, 10)).toBe('Hamburg-Harburg');
    expect(cleanName('Hauptbahnhof (oben)', 48.78, 9.18)).toBe('Stuttgart Hbf');
    expect(cleanName('Kassel Bahnhof Wilhelmshöhe', 51.3, 9.4)).toBe('Kassel Wilhelmshöhe');
  });
});
