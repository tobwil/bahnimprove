import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { buildStatic, cleanName, eachRow, unzipFeed } from '../src/data/gtfs.ts';
import { tileKey, tilesAround } from '../src/data/regional.ts';
import { addMessages, mergeReasons, parseIrisMessages, topReasons, type ReasonDay } from '../src/insights/reasons.ts';

const feed = (files: Record<string, string>) => unzipFeed(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
const common = {
  'agency.txt': 'agency_id,agency_name\n1,Testbahn\n',
  'calendar.txt': 'monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date,service_id\n1,1,1,1,1,1,1,20261001,20261231,s1\n',
  'calendar_dates.txt': 'service_id,exception_type,date\n',
  'stops.txt': 'stop_name,parent_station,stop_id,stop_lat,stop_lon,location_type\nCoburg,,A,50.26,10.96,1\nCoburg Gleis 1,A,A1,50.26,10.96,\n"Bamberg, Bahnhof",,B,49.90,10.90,1\nMünchen Hbf,,C,48.14,11.56,1\n',
};

describe('GTFS-Aufbereitung', () => {
  it('liest CSV mit Anführungszeichen zeilenweise', () => {
    const rows: string[] = [];
    eachRow('a,b\n"x, y",2\nz,3\r\n', (get) => rows.push(`${get('a')}|${get('b')}`));
    expect(rows).toEqual(['x, y|2', 'z|3']);
  });

  it('baut Fernverkehr und Regionalkacheln mit gemeinsamen Bahnhöfen', () => {
    const fv = feed({
      ...common,
      'routes.txt': 'route_id,agency_id,route_short_name,route_long_name\nr1,1,ICE 28,\n',
      'trips.txt': 'route_id,service_id,trip_id\nr1,s1,F1\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nF1,10:00:00,10:02:00,B,0\nF1,12:00:00,12:00:00,C,1\n',
    });
    const rv = feed({
      ...common,
      'routes.txt': 'route_id,agency_id,route_short_name,route_long_name\nr2,1,RE29,\n',
      'trips.txt': 'route_id,service_id,trip_id\nr2,s1,R1\n',
      'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nR1,09:00:00,09:00:00,A1,0\nR1,09:40:00,09:41:00,B,1\n',
    });
    const b = buildStatic(fv, rv, { start: '20261019', fvDays: 3, rvDays: 2, version: 'v1' });
    const names = b.timetable.stations.map((s) => s.name);
    expect(names).toContain('Coburg');
    expect(names).toContain('Bamberg');
    const bamberg = names.indexOf('Bamberg');
    expect(b.timetable.trips[0].stops[0]).toBe(bamberg);
    const tile = b.regional!.tiles.get(`20261019/${tileKey(50.26, 10.96)}`)!;
    expect(tile.trips[0].stops).toEqual([names.indexOf('Coburg'), bamberg]);
    expect(b.regional!.tripTiles.R1.length).toBeGreaterThanOrEqual(1);
    // Linienindex: Suche nach "RE 29" findet die Kachel, in der die Fahrt beginnt
    expect(b.regional!.index.lines).toEqual({ re29: [tileKey(50.26, 10.96)] });
    // Überblick: Fahrt 09:00–09:41 steckt in den Stunden 8, 9 und 10 (jeweils ± 1 h)
    expect([...b.regional!.overview.keys()].filter((k) => k.startsWith('20261019/')).sort()).toEqual(['20261019/08', '20261019/09', '20261019/10']);
    const [id, isS, stops, times] = b.regional!.overview.get('20261019/09')!.trips[0];
    expect([id, isS, stops, times]).toEqual(['R1', 0, [names.indexOf('Coburg'), bamberg], [540, 540, 580, 581]]);
    expect(b.timetable.stations[names.indexOf('Coburg')].w).toBeGreaterThan(0);
    expect(b.timetable.stations[names.indexOf('Coburg')].weight).toBe(0);
  });

  it('bereinigt Namen ohne Bahnhöfe zusammenzulegen', () => {
    expect(cleanName('Hamburg, Jungfernstieg', 53.5, 10)).toBe('Hamburg Jungfernstieg');
    expect(cleanName('Mannheim, Hauptbahnhof', 49.5, 8.5)).toBe('Mannheim Hbf');
  });

  it('findet Nachbarkacheln', () => {
    const around = tilesAround(50.26, 10.96);
    expect(around).toHaveLength(9);
    expect(around).toContain(tileKey(50.26, 10.96));
  });
});

describe('Verspätungsgründe', () => {
  const xml = `<timetable><s id="1"><ar><m id="a" t="d" c="48" ts="2610191010"/></ar></s><s id="2"><m id="b" t="h" ts="2610191010"/><dp><m id="c" t="d" c="38" ts="2610191011"/><m id="d" t="d" c="48" ts="2610181011"/></dp></s></timetable>`;

  it('liest nur Verspätungsmeldungen und zählt jede nur einmal', () => {
    const msgs = parseIrisMessages(xml);
    expect(msgs.map((m) => m.id)).toEqual(['a', 'c', 'd']);
    const day: ReasonDay = { date: '20261019', stations: {}, seen: {} };
    expect(addMessages(day, 'Köln Hbf', msgs)).toBe(2); // Meldung vom Vortag zählt nicht
    expect(addMessages(day, 'Köln Hbf', msgs)).toBe(0);
    expect(day.stations['Köln Hbf']).toEqual({ 48: 1, 38: 1 });
    const sum = mergeReasons([day, { date: '20261020', stations: { 'Köln Hbf': { 48: 4 } }, seen: {} }]);
    expect(sum.total['48']).toBe(5);
    expect(topReasons(sum.stations['Köln Hbf'])).toContain('Verspätung aus vorheriger Fahrt (83 %)');
  });
});
