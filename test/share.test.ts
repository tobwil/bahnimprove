import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CARD_H, CARD_W, renderCard, upscale } from '../src/share/card.ts';
import { encodePng } from '../src/share/png.ts';
import { CO2_G_PKM, PAIN_MIN, boardIndexOf, cleanName, co2Line, co2SavedKg, followHeadline, followStatus, isPain, targetIndexOf } from '../src/share/status.ts';
import { shareBrand } from '../src/ui/views.ts';
import { defaultPolicy, simulate } from '../src/sim/engine.ts';
import { buildDayModel } from '../src/sim/model.ts';
import type { Timetable } from '../src/sim/types.ts';

const tt = JSON.parse(readFileSync(new URL('../public/data/timetable.json', import.meta.url), 'utf8')) as Timetable;
const m = buildDayModel(tt, tt.dates[2]);
const r = simulate(m, defaultPolicy());
const T = m.trips.find((t) => t.stops.length > 6)!;
const R = r.trips[T.id];

describe('Live mitfahren', () => {
  it('findet den Ausstieg per Name, sonst den Endhalt', () => {
    const third = m.stations[T.stops[3]].name;
    expect(targetIndexOf(m.stations, T, third)).toBe(3);
    expect(targetIndexOf(m.stations, T, 'Gibt es nicht')).toBe(T.stops.length - 1);
    expect(targetIndexOf(m.stations, T, null)).toBe(T.stops.length - 1);
  });

  it('beschreibt vor, während und nach der Fahrt', () => {
    const target = 4;
    const before = followStatus(m.stations, T, R, target, R.dep[0] - 30);
    expect(before.state).toBe('before');
    expect(before.where).toMatch(/^Abfahrt/);
    const mid = (R.dep[1] + R.arr[2]) / 2;
    const running = followStatus(m.stations, T, R, target, mid);
    expect(running.state).toBe('running');
    expect(running.progress).toBeGreaterThan(0);
    expect(running.progress).toBeLessThan(1);
    expect(running.next).toBeDefined();
    const after = followStatus(m.stations, T, R, target, R.arr[target] + 1);
    expect(after.state).toBe('arrived');
    expect(after.progress).toBe(1);
    expect(followHeadline(after, 'Tobi')).toMatch(/^Tobi ist in .+ angekommen/);
    expect(followHeadline(running)).toMatch(/^Der Zug kommt um \d\d:\d\d in /);
  });

  it('meldet Ausfälle', () => {
    const st = followStatus(m.stations, T, { ...R, canceled: true }, 3, R.dep[0]);
    expect(st.state).toBe('canceled');
    expect(followHeadline(st)).toContain('fällt aus');
  });

  it('Share your Train, ab großer Verspätung Train Pain', () => {
    expect(isPain(PAIN_MIN - 1)).toBe(false);
    expect(isPain(PAIN_MIN)).toBe(true);
    expect(isPain(0, true)).toBe(true);
    expect(shareBrand(false)).not.toContain('Pain');
    expect(shareBrand(true)).toContain('<s>Train</s>');
    expect(shareBrand(true)).toContain('Pain');
  });

  it('rechnet die CO₂-Ersparnis gegenüber dem Auto (UBA 2024)', () => {
    expect(co2SavedKg('ICE', 600)).toBeCloseTo(((CO2_G_PKM.car - CO2_G_PKM.longDistance) * 600) / 1000);
    expect(co2SavedKg('RE', 100)).toBeCloseTo(((CO2_G_PKM.car - CO2_G_PKM.regional) * 100) / 1000);
    const all = followStatus(m.stations, T, R, T.stops.length - 1, R.dep[0]);
    const part = followStatus(m.stations, T, R, T.stops.length - 1, R.dep[0], 2);
    expect(part.km).toBeLessThan(all.km);
    expect(part.board).not.toBe(all.board);
    expect(boardIndexOf(m.stations, T, m.stations[T.stops[2]].name)).toBe(2);
    expect(co2Line(all)).toMatch(/kg CO₂ weniger als mit dem Auto/);
    expect(co2Line({ ...all, delay: PAIN_MIN })).toMatch(/^Pain is temporary, CO₂ reduction is forever/);
  });

  it('lässt im Namen nur Buchstaben zu', () => {
    expect(cleanName('<b>Tobi</b>')).toBe('bTobib');
    expect(cleanName('Anne-Marie Müller und sehr lange Namen')).toHaveLength(20);
    expect(cleanName(null)).toBe('');
    // Von einem Messenger an den Link gehängter Text
    expect(cleanName('Tobi Ich sitze im ICE 25 nach München. Hier siehst du')).toBe('Tobi');
  });

  it('erzeugt eine gültige PNG-Vorschaukarte', () => {
    const st = followStatus(m.stations, T, R, 4, (R.dep[1] + R.arr[2]) / 2);
    const px = renderCard(st, { name: 'Tobi', stamp: 600 });
    const png = encodePng(CARD_W * 2, CARD_H * 2, upscale(px, CARD_W, CARD_H, 2), (d) => deflateSync(d));
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(CARD_W * 2);
    expect(view.getUint32(20)).toBe(CARD_H * 2);
    // IDAT entpacken: Höhe × (1 Filterbyte + Breite × 4)
    const idatLen = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe(CARD_H * 2 * (CARD_W * 2 * 4 + 1));
  });
});
