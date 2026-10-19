/**
 * Ordnet den wichtigsten Bahnhöfen ihre EVA-Nummer in der IRIS-Schnittstelle der DB zu
 * (dort gibt es Verspätungsgründe je Bahnhof). Ergebnis: public/data/iris-stations.json
 *
 *   npx tsx scripts/build-iris-stations.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inGermany } from '../src/sim/model.ts';
import { fold } from '../src/sim/search.ts';
import type { Timetable } from '../src/sim/types.ts';

const IRIS = 'https://iris.noncd.db.de/iris-tts/timetable/station/';
const COUNT = 120;

const tt = JSON.parse(readFileSync('public/data/timetable.json', 'utf8')) as Timetable;
// Wichtig = viele Züge insgesamt, Fernverkehrsknoten zählen extra
const candidates = tt.stations
  .map((s, i) => ({ s, i, score: (s.w ?? 0) + s.weight * 3 }))
  .filter((x) => inGermany(x.s) && !/\(Gr\)|Grenze/.test(x.s.name))
  .sort((a, b) => b.score - a.score)
  .slice(0, COUNT);

const tokens = (s: string) => fold(s.replace(/\(M\)/g, ' Main ').replace(/Fernbf/g, 'Fernbahnhof').replace(/Bf\b/g, 'Bahnhof')).split(' ').filter((t) => t.length >= 2);

/** Ähnlichkeit zweier Bahnhofsnamen: gemeinsamer Anfang Pflicht, dann Anteil gemeinsamer Wörter. */
function similarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length || ta[0] !== tb[0]) return 0;
  const shared = ta.filter((t) => tb.some((u) => u === t || (t.length >= 4 && u.startsWith(t)) || (u.length >= 4 && t.startsWith(u)))).length;
  return shared / Math.max(ta.length, tb.length);
}

async function lookup(name: string): Promise<{ eva: string; name: string } | null> {
  const variants = [name, name.replace(/ \(/g, '(').replace(/\) /g, ')'), name.replace(/ \(([^)]+)\)/, ''), name.replace(/ /g, '-')];
  let best: { eva: string; name: string; score: number } | null = null;
  for (const v of [...new Set(variants)]) {
    const xml = await (await fetch(IRIS + encodeURIComponent(v))).text();
    for (const m of xml.matchAll(/<station [^>]*name="([^"]+)"[^>]*eva="(80\d+)"/g)) {
      const score = similarity(name, m[1]);
      if (!best || score > best.score) best = { name: m[1], eva: m[2], score };
    }
    if (best && best.score >= 0.99) break;
  }
  return best && best.score >= 0.6 ? best : null;
}

const out: { name: string; eva: string; iris: string }[] = [];
for (const c of candidates) {
  const hit = await lookup(c.s.name);
  if (hit) out.push({ name: c.s.name, eva: hit.eva, iris: hit.name });
  else console.warn(`Nicht gefunden: ${c.s.name}`);
}
writeFileSync('public/data/iris-stations.json', JSON.stringify(out, null, 1));
console.log(`${out.length} von ${candidates.length} Bahnhöfen zugeordnet`);
