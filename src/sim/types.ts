/** Kompakter Soll-Fahrplan, erzeugt von scripts/build-timetable.ts */
export interface Timetable {
  generatedAt: string;
  source: string;
  /** Verkehrstage (YYYYMMDD); Bit i in `TimetableTrip.days` steht für dates[i]. */
  dates: string[];
  routes: string[];
  stations: TimetableStation[];
  trips: TimetableTrip[];
}

export interface TimetableStation {
  name: string;
  lat: number;
  lon: number;
  /** Anzahl Halte im Feed – Maß für die Bedeutung des Knotens. */
  weight: number;
}

export interface TimetableTrip {
  /** trip_id im GTFS-Feed – Schlüssel für die Echtzeitdaten (GTFS-RT). */
  id: string;
  route: number;
  operator: string;
  days: number;
  stops: number[];
  /** Je Halt [Ankunft, Abfahrt] in Minuten ab Mitternacht des Verkehrstags (kann > 1440 sein). */
  times: number[];
  /** GTFS stop_sequence je Halt, nur wenn nicht 0, 1, 2, … */
  seqs?: number[];
}

/** Eine Fahrt an einem konkreten Verkehrstag. */
export interface Trip {
  id: number;
  gtfsId: string;
  /** GTFS stop_sequence je Halt */
  seqs: number[];
  line: string;
  category: string;
  operator: string;
  stops: number[];
  schedArr: number[];
  schedDep: number[];
}

export type IncidentKind =
  | 'oberleitung'
  | 'personen'
  | 'signal'
  | 'weiche'
  | 'bau'
  | 'notarzt'
  | 'fahrzeug';

export interface Incident {
  id: number;
  kind: IncidentKind;
  /** Abschnitt zwischen zwei Bahnhöfen (Indizes) bzw. Halt bei zugbezogenen Störungen (from === to). */
  from: number;
  to: number;
  /** Ort der Störung */
  lat: number;
  lon: number;
  start: number;
  end: number;
  /** Zusätzliche Fahrzeit je Zug in Minuten (nicht-sperrende Störungen). */
  extra: number;
  /** Strecke gesperrt – Züge warten bis `end`. */
  blocking: boolean;
  /** Mindestzugfolge in Minuten während der Störung (z. B. Weichenstörung), sonst undefiniert. */
  headway?: number;
  /** Für zugbezogene Störungen (Notarzt, Fahrzeug): Fahrt und Halt-Index. */
  trip?: number;
  stop?: number;
}

/** Warum ein Zug an einem Halt Zeit verloren hat. */
export type Cause =
  | { type: 'incident'; incident: number; minutes: number }
  /** Folgeverspätung: bei der Abfahrt (Zugfolge) oder unterwegs aufgelaufen (Überholverbot). */
  | { type: 'knockon'; trip: number; minutes: number; side: 'dep' | 'arr' }
  | { type: 'connection'; trip: number; minutes: number }
  | { type: 'yield'; trip: number; minutes: number }
  | { type: 'origin'; minutes: number }
  | { type: 'dwell'; minutes: number }
  | { type: 'ops'; minutes: number };

export interface TripResult {
  arr: number[];
  dep: number[];
  /** Nur bei Echtzeitdaten: false = für diese Fahrt liegen keine Daten vor (Sollzeiten). */
  known?: boolean;
  /** Nur bei Echtzeitdaten: Fahrt fällt aus. */
  canceled?: boolean;
  /** Ursachen je Halt-Index (für den Abschnitt, der an diesem Halt endet bzw. die Abfahrt dort). */
  causes: Cause[][];
}

export interface Connection {
  /** Zubringer */
  feeder: number;
  feederStop: number;
  /** Anschlusszug */
  departing: number;
  departingStop: number;
  station: number;
  passengers: number;
  /** Strafe in Minuten für Umsteiger, wenn der Anschluss verpasst wird (bis zur nächsten Fahrt). */
  missPenalty: number;
}

export interface Policy {
  /** Max. Wartezeit für Anschlüsse in Minuten (Standard-Wartezeitregel). */
  maxWait: number;
  /** Anschlüsse, die abweichend von der Regel gehalten/nicht gehalten werden: key = Index in connections. */
  connectionOverride: Map<number, 'hold' | 'release'>;
  /** Zug `leader` lässt am Halt (Bahnhof) `station` den Zug `follower` zuerst ausfahren. */
  yields: { leader: number; follower: number; station: number }[];
}

export interface SimResult {
  trips: TripResult[];
  connectionOutcome: ('kept' | 'held' | 'missed')[];
  /** Tatsächliche Wartezeit des Anschlusszugs je Anschluss. */
  connectionWait: number[];
}
