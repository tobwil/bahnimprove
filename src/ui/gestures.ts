/**
 * Touch- und Mausgesten für die Karte: Ziehen (mit Schwung), Pinch-Zoom, Doppeltipp, Tippen.
 * Jede Änderung der Fingerzahl setzt den Bezugspunkt neu – so springt die Karte nicht,
 * wenn beim Pinch ein Finger losgelassen wird.
 */
export interface GestureTarget {
  /** Verschieben in CSS-Pixeln */
  pan(dx: number, dy: number): void;
  /** Zoomen um `factor` um den Punkt (CSS-Pixel relativ zur Karte) */
  zoom(factor: number, x: number, y: number): void;
  tap(x: number, y: number): void;
  hover?(x: number, y: number): void;
}

const TAP_SLOP = 8;
const DOUBLE_TAP_MS = 280;
const FRICTION = 0.9;

export class MapGestures {
  private pts = new Map<number, { x: number; y: number }>();
  private anchor: { cx: number; cy: number; dist: number; n: number } | null = null;
  private down: { x: number; y: number; t: number } | null = null;
  private moved = false;
  private lastTap = { t: 0, x: 0, y: 0 };
  private velocity = { x: 0, y: 0 };
  private lastMove = 0;
  private tapTimer = 0;
  dragging = false;

  constructor(private el: HTMLElement, private target: GestureTarget) {
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', (e) => this.onUp(e, true));
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = this.local(e);
        // Trackpad-Pinch kommt als wheel mit ctrlKey
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
        target.zoom(factor, p.x, p.y);
      },
      { passive: false },
    );
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private snapshot() {
    const list = [...this.pts.values()];
    if (!list.length) return null;
    const cx = list.reduce((s, p) => s + p.x, 0) / list.length;
    const cy = list.reduce((s, p) => s + p.y, 0) / list.length;
    const dist = list.length >= 2 ? Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y) : 0;
    return { cx, cy, dist, n: list.length };
  }

  private onDown(e: PointerEvent) {
    this.el.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pts.set(e.pointerId, p);
    this.anchor = this.snapshot();
    this.velocity = { x: 0, y: 0 };
    if (this.pts.size === 1) {
      this.down = { ...p, t: performance.now() };
      this.moved = false;
    } else this.moved = true;
  }

  private onMove(e: PointerEvent) {
    const p = this.local(e);
    if (!this.pts.has(e.pointerId)) {
      if (e.pointerType === 'mouse') this.target.hover?.(p.x, p.y);
      return;
    }
    this.pts.set(e.pointerId, p);
    const s = this.snapshot()!;
    if (this.down && !this.moved && Math.hypot(p.x - this.down.x, p.y - this.down.y) > TAP_SLOP) this.moved = true;
    if (!this.moved || !this.anchor || this.anchor.n !== s.n) {
      this.anchor = s;
      return;
    }
    const dx = s.cx - this.anchor.cx, dy = s.cy - this.anchor.cy;
    if (dx || dy) this.target.pan(dx, dy);
    if (s.n >= 2 && this.anchor.dist > 0 && s.dist > 0) this.target.zoom(s.dist / this.anchor.dist, s.cx, s.cy);
    // Geschwindigkeit für den Schwung (nur beim Ziehen mit einem Finger)
    const now = performance.now();
    const dt = Math.max(1, now - this.lastMove);
    if (s.n === 1) this.velocity = { x: 0.8 * (dx / dt) * 16 + 0.2 * this.velocity.x, y: 0.8 * (dy / dt) * 16 + 0.2 * this.velocity.y };
    this.lastMove = now;
    this.dragging = true;
    this.el.classList.add('is-dragging');
    this.anchor = s;
  }

  private onUp(e: PointerEvent, cancel = false) {
    const p = this.local(e);
    this.pts.delete(e.pointerId);
    this.anchor = this.snapshot();
    if (this.pts.size) return;
    this.el.classList.remove('is-dragging');
    this.dragging = false;
    if (!cancel && !this.moved && this.down) {
      const now = performance.now();
      if (now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30) {
        clearTimeout(this.tapTimer);
        this.lastTap.t = 0;
        this.target.zoom(2, p.x, p.y);
        return;
      }
      this.lastTap = { t: now, x: p.x, y: p.y };
      // Kurz warten, ob ein Doppeltipp folgt – bei der Maus sofort auslösen
      if (e.pointerType === 'mouse') this.target.tap(p.x, p.y);
      else this.tapTimer = window.setTimeout(() => this.target.tap(p.x, p.y), DOUBLE_TAP_MS);
      return;
    }
    // Schwung nur, wenn der Finger zuletzt noch in Bewegung war
    if (performance.now() - this.lastMove > 80) this.velocity = { x: 0, y: 0 };
    this.down = null;
  }

  /** Einmal pro Frame aufrufen: lässt die Karte nach dem Loslassen ausrollen. */
  step() {
    if (this.dragging || (Math.abs(this.velocity.x) < 0.2 && Math.abs(this.velocity.y) < 0.2)) return;
    this.target.pan(this.velocity.x, this.velocity.y);
    this.velocity.x *= FRICTION;
    this.velocity.y *= FRICTION;
  }
}
