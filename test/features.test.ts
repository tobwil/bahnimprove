import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregateDay, findings, mergeDays } from '../src/insights/aggregate.ts';
import { defaultPolicy, simulate } from '../src/sim/engine.ts';
import { searchJourneys, transferProbability } from '../src/sim/journey.ts';
import { buildDayModel } from '../src/sim/model.ts';
import { observedResult } from '../src/sim/real.ts';
import { fold, matchStations, search } from '../src/sim/search.ts';
import type { RealtimeDay } from '../src/realtime/types.ts';
import type { Timetable } from '../src/sim/types.ts';

const tt = JSON.parse(readFileSync(new URL('../public/data/timetable.json', import.meta.url), 'utf8')) as Timetable;
const date = tt.dates[2];
const m = buildDayModel(tt, date);
const r = simulate(m, defaultPolicy());
const st = (name: string) => m.stations.findIndex((s) => s.name === name);

describe('Suche', () => {
  it('findet Bahnhöfe ohne Umlaute und mehrteilige Namen', () => {
    expect(fold('Köln Hbf')).toBe('koln hbf');
    expect(m.stations[matchStations(m, 'koeln')[0]].name).toBe('Köln Hbf');
    expect(m.stations[matchStations(m, ['frankfurt', 'flughafen'])[0]].name).toContain('Flughafen');
  });

  it('findet Linien und Strecken in Fahrtrichtung', () => {
    const line = search(m, r, 'ICE 28', 600);
    expect(line.trips.length).toBeGreaterThan(0);
    expect(line.trips.every((h) => m.trips[h.trip].line === 'ICE 28')).toBe(true);
    const route = search(m, r, 'Köln München', 600);
    const koeln = st('Köln Hbf'), muenchen = st('München Hbf');
    for (const h of route.trips) {
      const T = m.trips[h.trip];
      const a = T.stops.findIndex((s) => matchStations(m, 'köln', 40).includes(s));
      expect(a).toBeGreaterThanOrEqual(0);
      expect(T.stops.indexOf(muenchen)).toBeGreaterThan(a);
    }
    expect(koeln).toBeGreaterThanOrEqual(0);
  });
});

describe('Verbindungssuche', () => {
  it('findet Verbindungen mit gültigen Umstiegen', () => {
    const res = searchJourneys(m, r, st('Hamburg Hbf'), st('Stuttgart Hbf'), 9 * 60, 9 * 60);
    expect(res.journeys.length).toBeGreaterThan(0);
    expect(res.recommended).toBeGreaterThanOrEqual(0);
    for (const j of res.journeys) {
      expect(j.schedArr).toBeGreaterThan(j.schedDep);
      expect(m.trips[j.legs[0].trip].stops[j.legs[0].from]).toBe(st('Hamburg Hbf'));
      const last = j.legs[j.legs.length - 1];
      expect(m.trips[last.trip].stops[last.to]).toBe(st('Stuttgart Hbf'));
      for (const t of j.transfers) expect(t.planned).toBeGreaterThanOrEqual(t.needed);
    }
  });

  it('Umstiegswahrscheinlichkeit verhält sich plausibel', () => {
    expect(transferProbability(10, 5, 0, true)).toBe(1);
    expect(transferProbability(2, 5, 0, true)).toBe(0);
    expect(transferProbability(5, 5, 60, true)).toBeLessThan(transferProbability(12, 5, 60, true));
    expect(transferProbability(12, 5, 120, true)).toBeLessThan(transferProbability(12, 5, 10, true));
  });
});

describe('Lessons learned', () => {
  // Künstlicher Echtzeit-Tag: ein Abschnitt verliert immer 5 Minuten
  const T = m.trips.find((t) => t.stops.length >= 4)!;
  const sameSection = m.trips.filter((t) => t.stops.some((s, i) => s === T.stops[1] && t.stops[i + 1] === T.stops[2]));
  const day = (d: string): RealtimeDay => ({
    date: d,
    feedTime: 4102444800,
    trips: Object.fromEntries(
      sameSection.map((t) => {
        const i = t.stops.findIndex((s, k) => s === T.stops[1] && t.stops[k + 1] === T.stops[2]);
        return [t.gtfsId, { seen: 4102444800, u: t.stops.map((_, k) => [t.seqs[k], k > i ? 5 : 0, k > i ? 5 : 0, 0] as [number, number, number, 0]) }];
      }),
    ),
  });

  it('erkennt einen chronischen Fahrzeitverlust und wird mit mehr Tagen belastbarer', () => {
    const one = findings(mergeDays([aggregateDay(m, observedResult(m, day(date)).result)]), { minN: 1 });
    const f1 = one.findings.find((f) => f.kind === 'section');
    expect(f1).toBeDefined();
    expect(f1!.confidence).toBe('vorläufig');
    expect(one.preliminary).toBe(true);
    const aggs = Array.from({ length: 8 }, () => aggregateDay(m, observedResult(m, day(date)).result));
    const many = findings(mergeDays(aggs), { minN: 1 });
    const f8 = many.findings.find((f) => f.kind === 'section' && f.place === f1!.place)!;
    expect(f8.daysHit).toBe(8);
    expect(f8.n).toBe(f1!.n * 8);
    if (f8.n >= 40) expect(f8.confidence).toBe('belastbar');
  });

  it('zählt Prognosen nicht als Beobachtung', () => {
    const rt = day(date);
    for (const t of Object.values(rt.trips)) t.seen = 0; // letzte Meldung um Mitternacht → alles danach ist Prognose
    const agg = aggregateDay(m, observedResult(m, rt).result);
    expect(Object.keys(agg.sections).length).toBe(0);
  });
});
