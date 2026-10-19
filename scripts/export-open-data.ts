/**
 * Holt die verdichteten Tageswerte und Befunde von der Live-Seite und legt sie als offene Daten
 * im Repo ab (zugleich Sicherung, falls Server-Daten verloren gehen).
 *
 *   SITE=https://bahnimprove-leitstand.netlify.app npx tsx scripts/export-open-data.ts
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Insights } from '../src/insights/aggregate.ts';
import { reasonText } from '../src/insights/reasons.ts';

const SITE = process.env.SITE ?? 'https://bahnimprove-leitstand.netlify.app';
const DIR = 'open-data';

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${SITE}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
};

/** ISO-Kalenderwoche "2026-W43" */
function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const csv = (rows: (string | number)[][]) => rows.map((r) => r.map((c) => (typeof c === 'string' && /[",;\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';

async function main() {
  mkdirSync(`${DIR}/tage`, { recursive: true });
  mkdirSync(`${DIR}/berichte`, { recursive: true });
  const index = await get<{ days: string[]; reasons: string[] }>('/api/open-data');
  let added = 0;
  for (const date of new Set([...index.days, ...index.reasons])) {
    const file = `${DIR}/tage/${date}.json`;
    if (existsSync(file)) continue;
    writeFileSync(file, JSON.stringify(await get(`/api/open-data?date=${date}`)));
    added++;
  }
  const ins = await get<Insights>('/api/insights');
  writeFileSync(`${DIR}/befunde.json`, JSON.stringify(ins, null, 1));
  writeFileSync(
    `${DIR}/befunde.csv`,
    csv([
      ['art', 'ort', 'belastbarkeit', 'faelle', 'tage_mit_problem', 'tage', 'anteil', 'median_min', 'minuten_pro_tag', 'befund', 'gemeldete_gruende', 'massnahme'],
      ...ins.findings.map((f) => [f.kind, f.place, f.confidence, f.n, f.daysHit, f.days, +f.share.toFixed(3), f.median, Math.round(f.minutesPerDay), f.evidence, f.reasons ?? '', f.measure]),
    ]),
  );
  // Lesbarer Wochenbericht
  const week = isoWeek();
  const top = ins.findings.filter((f) => f.kind !== 'reserve').slice(0, 10);
  const reasons = Object.entries(ins.reasons?.total ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const rTotal = Object.values(ins.reasons?.total ?? {}).reduce((a, b) => a + b, 0) || 1;
  const md = `# Bahnimprove Wochenbericht ${week}

Aus ${ins.dates.length} Tagen echter Ist-Daten (${ins.dates[0] ?? '–'} bis ${ins.dates[ins.dates.length - 1] ?? '–'}), ${ins.trips} Fernverkehrsfahrten, ${ins.arrivals} beobachtete Ankünfte.
Pünktlichkeit (Ankünfte unter 6 Minuten Verspätung): **${(ins.punctuality * 100).toFixed(1)} %**.

Live: ${SITE}/bericht

## Die größten Hebel

| Ort | Befund | Maßnahme | Min/Tag | Belastbarkeit |
|---|---|---|---:|---|
${top.map((f) => `| ${f.place} | ${f.evidence}${f.reasons ? ` Gemeldete Gründe: ${f.reasons}.` : ''} | ${f.measure} | ${Math.round(f.minutesPerDay)} | ${f.confidence} |`).join('\n')}

## Von der DB gemeldete Gründe

${reasons.map(([c, n]) => `- ${reasonText(+c)}: ${Math.round((n / rTotal) * 100)} %`).join('\n') || '- noch keine Daten'}

## Methode

Nur beobachtete Ist-Zeiten (keine Prognosen). Ein Befund ist *belastbar* ab 40 Fällen aus mindestens 7 Tagen, wenn er an der Mehrzahl der Tage auftritt.
Fahrplan: DELFI e.V./gtfs.de (CC BY 4.0), Echtzeit: gtfs.de (CC BY-SA 4.0), Verspätungsgründe: IRIS-Schnittstelle der Deutschen Bahn. Diese Auswertung: CC BY-SA 4.0, Bahnimprove.
`;
  writeFileSync(`${DIR}/berichte/${week}.md`, md);
  console.log(`${added} neue Tage, ${ins.findings.length} Befunde, Bericht ${week}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
