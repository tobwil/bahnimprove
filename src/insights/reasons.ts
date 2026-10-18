/**
 * Verspätungsgründe aus der IRIS-Schnittstelle der DB (Meldungen vom Typ "d" mit Code).
 * Die Codes sind die offiziellen Grundcodes der DB-Fahrgastinformation.
 */

export type ReasonGroup = 'infrastruktur' | 'fahrzeug' | 'betrieb' | 'extern' | 'personal' | 'ausland' | 'fahrgaeste';

export const REASON_GROUPS: Record<ReasonGroup, { label: string; lever: string }> = {
  infrastruktur: { label: 'Infrastruktur', lever: 'Strecke, Signale, Weichen, Oberleitung, Baustellen: Instandhaltung und Bauplanung (DB InfraGO)' },
  betrieb: { label: 'Betriebsablauf', lever: 'Folgeverspätungen, Reihenfolge, Bereitstellung: Disposition, Fahrplanpuffer, Umläufe' },
  fahrzeug: { label: 'Fahrzeuge', lever: 'Reparaturen, Türstörungen: Wartung und Fahrzeugreserve' },
  extern: { label: 'Äußere Einflüsse', lever: 'Polizei, Notarzt, Personen im Gleis, Wetter: kaum beeinflussbar, aber schneller wieder anlaufen' },
  personal: { label: 'Personal', lever: 'Kurzfristiger Personalausfall: Personalreserve' },
  ausland: { label: 'Ausland', lever: 'Verspätung aus dem Ausland: Puffer am Grenzübergang, Abstimmung mit Partnerbahnen' },
  fahrgaeste: { label: 'Fahrgastwechsel', lever: 'Ein- und Ausstieg: Bahnsteigorganisation, Haltezeiten' },
};

const R: Record<number, [string, ReasonGroup]> = {
  2: ['Polizeiliche Ermittlung', 'extern'],
  3: ['Feuerwehreinsatz an der Strecke', 'extern'],
  4: ['Kurzfristiger Personalausfall', 'personal'],
  5: ['Ärztliche Versorgung eines Fahrgastes', 'extern'],
  6: ['Betätigen der Notbremse', 'extern'],
  7: ['Personen im Gleis', 'extern'],
  8: ['Notarzteinsatz am Gleis', 'extern'],
  9: ['Streikauswirkungen', 'extern'],
  10: ['Tiere im Gleis', 'extern'],
  11: ['Unwetter', 'extern'],
  12: ['Warten auf ein verspätetes Schiff', 'betrieb'],
  13: ['Pass- und Zollkontrolle', 'ausland'],
  14: ['Technische Störung am Bahnhof', 'infrastruktur'],
  15: ['Beeinträchtigung durch Vandalismus', 'extern'],
  16: ['Entschärfung einer Fliegerbombe', 'extern'],
  17: ['Beschädigung einer Brücke', 'infrastruktur'],
  18: ['Umgestürzter Baum im Gleis', 'extern'],
  19: ['Unfall an einem Bahnübergang', 'extern'],
  20: ['Tiere im Gleis', 'extern'],
  21: ['Warten auf Fahrgäste aus einem anderen Zug', 'betrieb'],
  22: ['Witterungsbedingte Störung', 'extern'],
  23: ['Feuerwehreinsatz auf Bahngelände', 'extern'],
  24: ['Verspätung im Ausland', 'ausland'],
  25: ['Warten auf weitere Wagen', 'betrieb'],
  28: ['Gegenstände im Gleis', 'extern'],
  29: ['Ersatzverkehr mit Bus', 'betrieb'],
  31: ['Bauarbeiten', 'infrastruktur'],
  32: ['Verzögerung beim Ein- und Ausstieg', 'fahrgaeste'],
  33: ['Reparatur an der Oberleitung', 'infrastruktur'],
  34: ['Reparatur an einem Signal', 'infrastruktur'],
  35: ['Streckensperrung', 'infrastruktur'],
  36: ['Reparatur am Zug', 'fahrzeug'],
  37: ['Reparatur am Wagen', 'fahrzeug'],
  38: ['Reparatur an der Strecke', 'infrastruktur'],
  39: ['Anhängen zusätzlicher Wagen', 'betrieb'],
  40: ['Defektes Stellwerk', 'infrastruktur'],
  41: ['Technische Störung an einem Bahnübergang', 'infrastruktur'],
  42: ['Außerplanmäßige Geschwindigkeitsbeschränkung', 'infrastruktur'],
  43: ['Verspätung eines vorausfahrenden Zuges', 'betrieb'],
  44: ['Warten auf einen entgegenkommenden Zug', 'betrieb'],
  45: ['Vorfahrt eines anderen Zuges', 'betrieb'],
  46: ['Vorfahrt eines anderen Zuges', 'betrieb'],
  47: ['Verspätete Bereitstellung des Zuges', 'betrieb'],
  48: ['Verspätung aus vorheriger Fahrt', 'betrieb'],
  49: ['Kurzfristiger Personalausfall', 'personal'],
  50: ['Kurzfristige Erkrankung von Personal', 'personal'],
  51: ['Verspätetes Personal aus vorheriger Fahrt', 'personal'],
  52: ['Streik', 'extern'],
  53: ['Unwetterauswirkungen', 'extern'],
  54: ['Verfügbarkeit der Gleise derzeit eingeschränkt', 'infrastruktur'],
  55: ['Technische Störung an einem anderen Zug', 'fahrzeug'],
  56: ['Warten auf Fahrgäste aus einem Bus', 'betrieb'],
  57: ['Zusätzlicher Halt zum Ein- und Ausstieg', 'fahrgaeste'],
  58: ['Umleitung des Zuges', 'infrastruktur'],
  59: ['Schnee und Eis', 'extern'],
  60: ['Reduzierte Geschwindigkeit wegen Sturm', 'extern'],
  61: ['Türstörung', 'fahrzeug'],
  62: ['Behobene technische Störung am Zug', 'fahrzeug'],
  63: ['Technische Untersuchung am Zug', 'fahrzeug'],
  64: ['Weichenstörung', 'infrastruktur'],
  65: ['Erdrutsch', 'extern'],
  66: ['Hochwasser', 'extern'],
  99: ['Verzögerungen im Betriebsablauf', 'betrieb'],
};

export const reasonText = (code: number) => R[code]?.[0] ?? `Grund ${code}`;
export const reasonGroup = (code: number): ReasonGroup | null => R[code]?.[1] ?? null;

/** Gemeldete Gründe eines Verkehrstags: Bahnhof → Code → Anzahl Meldungen. */
export interface ReasonDay {
  date: string;
  stations: Record<string, Record<string, number>>;
  /** Schon gezählte Meldungen je Bahnhof (IRIS-ID), damit wiederholte Abrufe nicht doppelt zählen */
  seen: Record<string, string[]>;
}

/** Liest Verspätungsmeldungen aus einer IRIS-Antwort (fchg). `ts` im Format YYMMDDHHmm. */
export function parseIrisMessages(xml: string): { id: string; code: number; ts: string }[] {
  const out: { id: string; code: number; ts: string }[] = [];
  for (const m of xml.matchAll(/<m ([^>]*?)\/?>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (a.t !== 'd' || !a.c || !a.id) continue;
    out.push({ id: a.id, code: +a.c, ts: a.ts ?? '' });
  }
  return out;
}

export function addMessages(day: ReasonDay, station: string, msgs: { id: string; code: number; ts: string }[]): number {
  const seen = new Set(day.seen[station] ?? []);
  const counts = (day.stations[station] ??= {});
  let added = 0;
  for (const m of msgs) {
    // Nur Meldungen dieses Verkehrstags (IRIS liefert ein Zeitfenster über Mitternacht hinweg)
    if (!m.ts.startsWith(day.date.slice(2))) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    counts[m.code] = (counts[m.code] ?? 0) + 1;
    added++;
  }
  day.seen[station] = [...seen];
  return added;
}

export interface ReasonSummary {
  total: Record<string, number>;
  stations: Record<string, Record<string, number>>;
  days: number;
}

export function mergeReasons(days: ReasonDay[]): ReasonSummary {
  const total: Record<string, number> = {};
  const stations: Record<string, Record<string, number>> = {};
  for (const d of days) {
    for (const [st, codes] of Object.entries(d.stations)) {
      const s = (stations[st] ??= {});
      for (const [c, n] of Object.entries(codes)) {
        s[c] = (s[c] ?? 0) + n;
        total[c] = (total[c] ?? 0) + n;
      }
    }
  }
  return { total, stations, days: days.length };
}

/** "Verspätung aus vorheriger Fahrt (38 %), Reparatur an der Strecke (14 %)" */
export function topReasons(codes: Record<string, number> | undefined, n = 3): string {
  if (!codes) return '';
  const sum = Object.values(codes).reduce((a, b) => a + b, 0);
  if (sum < 5) return '';
  return Object.entries(codes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([c, k]) => `${reasonText(+c)} (${Math.round((k / sum) * 100)} %)`)
    .join(', ');
}
