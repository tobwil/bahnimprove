import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CARD_H, CARD_W, renderCard, upscale } from '../src/share/card.ts';
import { encodePng } from '../src/share/png.ts';
import { cleanName, followHeadline, followStatus, targetIndexOf } from '../src/share/status.ts';
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
