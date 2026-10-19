import { delayColor } from './dom.ts';

const START = 180;
const SPAN = 1440;

/** Tagesverlauf als Pixel-Balken (Höhe = Verkehr, Farbe = Pünktlichkeit) mit Abspielkopf; Ziehen spult. */
export class Timeline {
  private ctx: CanvasRenderingContext2D;
  private bins: { arrivals: number; punctual: number }[] = [];
  /** Bis hierhin sind Daten Vergangenheit (Live-Uhr); danach Prognose. */
  private nowMinute = Infinity;

  /**
   * Spulen nur bei waagrechtem Ziehen oder einem Tipp. Senkrechtes Wischen gehört dem Sheet
   * (onVertical übernimmt die Geste), damit man beim Hoch- und Runterwischen nicht versehentlich spult.
   */
  constructor(
    private canvas: HTMLCanvasElement,
    onScrub: (minute: number) => void,
    onVertical?: (e: PointerEvent, startY: number) => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    const scrub = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      onScrub(START + f * SPAN);
    };
    let start: { x: number; y: number; id: number } | null = null;
    let mode: 'scrub' | 'none' | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      mode = null;
      // Maus: sofort spulen wie gewohnt
      if (e.pointerType === 'mouse') {
        mode = 'scrub';
        canvas.setPointerCapture(e.pointerId);
        scrub(e);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      if (mode === 'scrub') return scrub(e);
      if (mode) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) < 8) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        mode = 'scrub';
        canvas.setPointerCapture(e.pointerId);
        scrub(e);
      } else {
        mode = 'none';
        onVertical?.(e, start.y);
      }
    });
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      // Bewusster Tipp springt zur Uhrzeit
      if (mode === null && e.type === 'pointerup') scrub(e);
      start = null;
      mode = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  setData(bins: { arrivals: number; punctual: number }[], nowMinute: number) {
    this.bins = bins;
    this.nowMinute = nowMinute;
  }

  draw(minute: number) {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    // Niedrige Auflösung für den Pixel-Look
    const w = Math.max(48, Math.floor(r.width / 2));
    const h = Math.max(12, Math.floor(r.height / 2));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#131a30';
    ctx.fillRect(0, h - 1, w, 1);
    const max = Math.max(1, ...this.bins.map((b) => b.arrivals));
    const bw = w / 24;
    this.bins.forEach((b, i) => {
      if (!b.arrivals) return;
      const p = b.punctual / b.arrivals;
      const bh = Math.max(2, Math.round((b.arrivals / max) * (h - 3)));
      const x0 = Math.round(i * bw), x1 = Math.round((i + 1) * bw) - 1;
      const future = START + i * 60 > this.nowMinute;
      ctx.globalAlpha = future ? 0.35 : 1;
      ctx.fillStyle = delayColor(p > 0.85 ? 0 : p > 0.7 ? 10 : p > 0.55 ? 20 : 40);
      ctx.fillRect(x0, h - 1 - bh, Math.max(1, x1 - x0), bh);
    });
    ctx.globalAlpha = 1;
    const x = Math.round(((minute - START) / SPAN) * w);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.min(w - 2, Math.max(0, x - 1)), 0, 2, h);
    ctx.fillStyle = '#ffc56b';
    ctx.fillRect(Math.min(w - 4, Math.max(0, x - 2)), 0, 4, 2);
  }
}
