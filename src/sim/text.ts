import type { DayModel } from './model.ts';
import type { Cause, Incident, IncidentKind } from './types.ts';

export const INCIDENT_LABEL: Record<IncidentKind, string> = {
  oberleitung: 'Oberleitungsstörung',
  personen: 'Personen im Gleis',
  signal: 'Signalstörung',
  weiche: 'Weichenstörung',
  bau: 'Baustelle / Langsamfahrstelle',
  notarzt: 'Notarzteinsatz am Zug',
  fahrzeug: 'Reparatur am Zug',
};

export function hhmm(minutes: number): string {
  const m = Math.floor(((minutes % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export const fmtDelay = (d: number) => (d < 0.5 ? '±0' : `+${Math.round(d)}`);

/** Kurzname für Karte und Listen: "Frankfurt (Main) Hbf" → "Frankfurt", "Berlin Südkreuz" bleibt. */
export function shortName(name: string): string {
  return name
    .replace(/ Hbf$/, '')
    .replace(/ \(Main\)/, '')
    .replace(/ \(Saale\)/, '')
    .replace(/ \(Westf\)/, '')
    .replace(/ Fernbahnhof$/, '')
    .replace(/ Centraal$/, '')
    .replace(/ HB$/, '')
    .trim();
}

export function tripLabel(m: DayModel, trip: number): string {
  const T = m.trips[trip];
  return `${T.line} ${shortName(m.stations[T.stops[0]].name)} → ${shortName(m.stations[T.stops[T.stops.length - 1]].name)}`;
}

export function tripLabelWithTime(m: DayModel, trip: number): string {
  return `${tripLabel(m, trip)} (${hhmm(m.trips[trip].schedDep[0])})`;
}

export function incidentPlace(m: DayModel, inc: Incident): string {
  const a = shortName(m.stations[inc.from].name);
  if (inc.from === inc.to) return a;
  return `${a} – ${shortName(m.stations[inc.to].name)}`;
}

export function causeText(m: DayModel, c: Cause): string {
  const min = `+${Math.max(1, Math.round(c.minutes))} Min`;
  switch (c.type) {
    case 'incident': {
      const inc = m.incidents[c.incident];
      return `${min} ${INCIDENT_LABEL[inc.kind]} (${incidentPlace(m, inc)})`;
    }
    case 'knockon':
      return `${min} ${c.side === 'dep' ? 'wartet hinter' : 'hängt fest hinter'} ${tripLabel(m, c.trip)}`;
    case 'connection':
      return `${min} wartet auf Anschluss von ${tripLabel(m, c.trip)}`;
    case 'yield':
      return `${min} lässt ${tripLabel(m, c.trip)} vor`;
    case 'origin':
      return `${min} verspätete Bereitstellung`;
    case 'dwell':
      return `${min} verlängerter Halt (Fahrgastwechsel)`;
    case 'ops':
      return `${min} betriebliche Gründe`;
  }
}

export const CAUSE_LABEL: Record<Cause['type'], string> = {
  incident: 'Störungen & Baustellen',
  knockon: 'Folgeverspätung',
  connection: 'Anschlusswartezeit',
  yield: 'Überholung',
  origin: 'Bereitstellung',
  dwell: 'Fahrgastwechsel',
  ops: 'Betrieb / Mischverkehr',
};

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('de-DE');
}

export function fmtPct(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits).replace('.', ',')} %`;
}
