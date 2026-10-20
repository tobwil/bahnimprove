/**
 * Überblick über alle Regionalzüge Deutschlands: eine Datei je Stunde mit allen Fahrten um diese
 * Zeit (nur Halte und Zeiten) plus eine Verspätung je Fahrt. Damit füllt sich die Deutschlandkarte
 * sofort; beim Heranzoomen übernehmen die Kacheln mit allen Details.
 */
import type { OverviewChunk, OverviewDelays } from '../data/regional.ts';
import type { TimetableStation } from '../sim/types.ts';

const DELAYS_MS = 110_000;

export class OverviewLayer {
  private chunks = new Map<number, OverviewChunk | null>();
  private pending = new Set<number>();
  private delays: OverviewDelays | null = null;
  private canceled = new Set<string>();
  private delaysAt = 0;
  private delaysPending = false;
  /** Andere Fahrplanversion oder kein Server: Überblick aus */
  disabled = false;

  constructor(
    private stations: TimetableStation[],
    readonly date: string,
    private version: string | undefined,
  ) {}

  /** Nötige Stunden (und im Live-Betrieb die Verspätungen) nachladen */
  update(minute: number, live: boolean) {
    if (this.disabled) return;
    const h = Math.max(0, Math.floor(minute / 60));
    this.load(h);
    if (minute % 60 > 50) this.load(h + 1);
    if (live && !this.delaysPending && Date.now() - this.delaysAt > DELAYS_MS) void this.loadDelays();
  }

  /**
   * Positionen zur Minute `minute` als [lon, lat, Verspätung (−1 = unbekannt)]-Tripel.
   * `show(id, s)` entscheidet je Fahrt (schon als Kachel geladen, Filter der Karte).
   */
  points(minute: number, live: boolean, show: (id: string, s: boolean, delay: number | undefined) => boolean): number[] {
    const chunk = this.chunks.get(Math.max(0, Math.floor(minute / 60)));
    if (!chunk) return [];
    const st = this.stations;
    const d = live ? this.delays?.d : undefined;
    const out: number[] = [];
    for (const [id, s, stops, times] of chunk.trips) {
      if (live && this.canceled.has(id)) continue;
      const delay = d?.[id];
      // Verspäteter Zug: steht dort, wo er laut Fahrplan vor `delay` Minuten war
      const t = minute - (delay ?? 0);
      const n = stops.length;
      if (t < times[1] || t > times[(n - 1) * 2]) continue;
      if (!show(id, s === 1, delay)) continue;
      let lon = 0, lat = 0;
      for (let i = 0; i < n; i++) {
        const arr = times[i * 2], dep = times[i * 2 + 1];
        if (t <= dep) {
          const a = st[stops[i]];
          if (t >= arr || i === 0) [lon, lat] = [a.lon, a.lat];
          else {
            // zwischen Halt i−1 und i
            const p = st[stops[i - 1]], prevDep = times[(i - 1) * 2 + 1];
            const k = arr > prevDep ? (t - prevDep) / (arr - prevDep) : 1;
            lon = p.lon + (a.lon - p.lon) * k;
            lat = p.lat + (a.lat - p.lat) * k;
          }
          break;
        }
      }
      out.push(lon, lat, delay ?? -1);
    }
    return out;
  }

  private load(h: number) {
    if (this.chunks.has(h) || this.pending.has(h)) return;
    this.pending.add(h);
    void this.fetchChunk(h)
      .then((c) => this.chunks.set(h, c))
      .finally(() => this.pending.delete(h));
  }

  private async fetchChunk(h: number): Promise<OverviewChunk | null> {
    const v = this.version ? `&v=${encodeURIComponent(this.version)}` : '';
    try {
      const r = await fetch(`api/rv-ueberblick?date=${this.date}&h=${h}${v}`);
      if (r.status === 409) {
        this.disabled = true;
        return null;
      }
      if (r.ok && r.headers.get('content-type')?.includes('json')) return (await r.json()) as OverviewChunk;
    } catch {
      // lokal: statische Datei
    }
    try {
      const r = await fetch(`data/rv/ov/${this.date}/${String(h).padStart(2, '0')}.json`);
      if (!r.ok || !r.headers.get('content-type')?.includes('json')) return null;
      const c = (await r.json()) as OverviewChunk;
      return !this.version || !c.version || c.version === this.version ? c : null;
    } catch {
      return null;
    }
  }

  private async loadDelays() {
    this.delaysPending = true;
    try {
      const r = await fetch(`api/rv-jetzt?date=${this.date}`);
      if (r.ok && r.headers.get('content-type')?.includes('json')) {
        this.delays = (await r.json()) as OverviewDelays;
        this.canceled = new Set(this.delays.x);
      }
    } catch {
      // ohne Verspätungen: Punkte laut Fahrplan
    } finally {
      this.delaysAt = Date.now();
      this.delaysPending = false;
    }
  }
}
