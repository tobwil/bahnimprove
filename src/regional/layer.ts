/**
 * Regionalverkehr in der App: lädt Kacheln nach Bedarf (sichtbarer Ausschnitt, eigener Standort,
 * Start und Ziel einer Reise), hält sie mit Echtzeitdaten aktuell und führt sie mit dem
 * Fernverkehr zu einem gemeinsamen Netz zusammen.
 */
import type { RegionalTile } from '../data/regional.ts';
import type { RealtimeDay } from '../realtime/types.ts';
import { categoryOf, type DayModel } from '../sim/model.ts';
import { berlinMidnightEpoch, observeTrip } from '../sim/real.ts';
import type { SimResult, TimetableStation, Trip, TripResult } from '../sim/types.ts';

const REFRESH_MS = 120_000;

interface LoadedTile {
  at: number;
  trips: number[];
}

export interface Network {
  model: DayModel;
  result: SimResult;
  /** Fahrten mit id ≥ fvCount sind Regionalzüge */
  fvCount: number;
  /** Wird bei jeder Änderung erhöht (für Caches) */
  rev: number;
}

export class RegionalLayer {
  private tiles = new Map<string, LoadedTile>();
  private pending = new Map<string, Promise<void>>();
  private byGtfs = new Map<string, number>();
  private trips: Trip[] = [];
  private results: TripResult[] = [];
  private rev = 0;
  private netCache: { key: string; net: Network } | null = null;
  /** Server lehnt ab (andere Fahrplanversion) oder liefert nichts → Regionalverkehr aus */
  disabled = false;
  onChange?: () => void;

  constructor(
    private stations: TimetableStation[],
    readonly date: string,
    private version: string | undefined,
  ) {}

  get loadedTiles() {
    return this.tiles.size;
  }

  /** Lädt fehlende Kacheln (und frischt alte auf). true, wenn sich etwas geändert hat. */
  async ensure(keys: string[]): Promise<boolean> {
    if (this.disabled) return false;
    const now = Date.now();
    const todo = keys.filter((k) => !this.pending.has(k) && (!this.tiles.has(k) || now - this.tiles.get(k)!.at > REFRESH_MS));
    if (!todo.length) {
      await Promise.all(keys.map((k) => this.pending.get(k)).filter(Boolean));
      return false;
    }
    const before = this.rev;
    await Promise.all(
      todo.map((k) => {
        const p = this.load(k).finally(() => this.pending.delete(k));
        this.pending.set(k, p);
        return p;
      }),
    );
    if (this.rev !== before) this.onChange?.();
    return this.rev !== before;
  }

  /** Alle geladenen Kacheln auffrischen (Echtzeit). */
  refresh() {
    return this.ensure([...this.tiles.keys()].filter((k) => Date.now() - this.tiles.get(k)!.at > REFRESH_MS));
  }

  private async fetchTile(key: string): Promise<(RegionalTile & { rt: RealtimeDay | null }) | null> {
    const v = this.version ? `&v=${encodeURIComponent(this.version)}` : '';
    try {
      const r = await fetch(`api/rv?date=${this.date}&tile=${key}${v}`);
      if (r.status === 409) {
        this.disabled = true;
        return null;
      }
      if (r.ok && r.headers.get('content-type')?.includes('json')) return await r.json();
    } catch {
      // lokal: statische Dateien
    }
    try {
      const r = await fetch(`data/rv/${this.date}/${key}.json`);
      if (!r.ok || !r.headers.get('content-type')?.includes('json')) return r.status === 404 ? emptyTile(key, this.date) : null;
      const tile = (await r.json()) as RegionalTile;
      if (this.version && tile.version && tile.version !== this.version) {
        this.disabled = true;
        return null;
      }
      return { ...tile, rt: await localRealtime(this.date) };
    } catch {
      return null;
    }
  }

  private async load(key: string) {
    const tile = await this.fetchTile(key);
    if (!tile) return;
    const midnight = berlinMidnightEpoch(this.date);
    const ids: number[] = [];
    for (const t of tile.trips) {
      let id = this.byGtfs.get(t.id);
      if (id === undefined) {
        id = this.trips.length;
        this.byGtfs.set(t.id, id);
        const line = t.line.replace(/^(RE|RB|S|IRE|MEX|ALX|FEX|IC)(\d)/, '$1 $2');
        this.trips.push({
          id,
          gtfsId: t.id,
          seqs: t.seqs ?? t.stops.map((_, i) => i),
          line,
          category: /^\d+$/.test(t.line) ? 'RB' : categoryOf(line),
          operator: tile.ops[t.op] ?? '',
          stops: t.stops,
          schedArr: t.stops.map((_, i) => t.times[i * 2]),
          schedDep: t.stops.map((_, i) => t.times[i * 2 + 1]),
        });
      }
      this.results[id] = observeTrip(this.trips[id], tile.rt?.trips[t.id], midnight);
      ids.push(id);
    }
    this.tiles.set(key, { at: Date.now(), trips: ids });
    this.rev++;
  }

  /** Gemeinsames Netz aus Fern- und Regionalverkehr (Regionalzüge hinten angehängt). */
  network(fvModel: DayModel, fvResult: SimResult): Network {
    const key = `${this.rev}|${fvModel.trips.length}`;
    if (this.netCache && this.netCache.key === key && this.netCache.net.result.trips[0] === fvResult.trips[0]) return this.netCache.net;
    const fvCount = fvModel.trips.length;
    const trips = fvModel.trips.concat(this.trips.map((t) => ({ ...t, id: t.id + fvCount })));
    const results = fvResult.trips.concat(this.trips.map((t) => this.results[t.id]));
    const net: Network = {
      model: { ...fvModel, trips },
      result: { ...fvResult, trips: results },
      fvCount,
      rev: this.rev,
    };
    this.netCache = { key, net };
    return net;
  }

  stationsCount() {
    return this.stations.length;
  }
}

function emptyTile(tile: string, date: string): RegionalTile & { rt: null } {
  return { version: '', date, tile, ops: [], trips: [], rt: null };
}

let localRt: { date: string; at: number; day: RealtimeDay | null } | null = null;
async function localRealtime(date: string): Promise<RealtimeDay | null> {
  if (localRt && localRt.date === date && Date.now() - localRt.at < REFRESH_MS) return localRt.day;
  try {
    const r = await fetch(`data/realtime/rv-${date}.json`, { cache: 'no-cache' });
    const day = r.ok && r.headers.get('content-type')?.includes('json') ? ((await r.json()) as RealtimeDay) : null;
    localRt = { date, at: Date.now(), day };
    return day;
  } catch {
    return null;
  }
}
