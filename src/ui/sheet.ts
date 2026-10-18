export type Snap = 'peek' | 'half' | 'full';

/**
 * Bottom-Sheet auf dem Handy: ziehen am Griff oder Statusbereich, rastet auf drei Höhen ein.
 * Auf breiten Bildschirmen ist das Sheet eine feste Seitenleiste (CSS), Ziehen ist dann aus.
 */
export class Sheet {
  snap: Snap = 'peek';
  private listeners: ((s: Snap) => void)[] = [];

  constructor(private el: HTMLElement, handles: HTMLElement[]) {
    for (const h of handles) this.bindDrag(h);
  }

  get docked() {
    return window.matchMedia('(min-width: 1000px)').matches;
  }

  onChange(fn: (s: Snap) => void) {
    this.listeners.push(fn);
  }

  set(snap: Snap) {
    if (this.docked) return;
    this.snap = snap;
    this.el.dataset.snap = snap;
    this.el.style.transform = '';
    this.listeners.forEach((fn) => fn(snap));
  }

  /** Sichtbare Höhe des Sheets in CSS-Pixeln (für die Kartenmitte). */
  visibleHeight(): number {
    if (this.docked) return 0;
    const r = this.el.getBoundingClientRect();
    return Math.max(0, window.innerHeight - r.top);
  }

  private bindDrag(handle: HTMLElement) {
    let start: { y: number; top: number; t: number } | null = null;
    let moved = false;
    handle.addEventListener('pointerdown', (e) => {
      if (this.docked || (e.target as HTMLElement).closest('button')) return;
      start = { y: e.clientY, top: this.el.getBoundingClientRect().top, t: performance.now() };
      moved = false;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dy = e.clientY - start.y;
      if (!moved && Math.abs(dy) < 6) return;
      moved = true;
      this.el.classList.add('is-dragging');
      const parent = this.el.offsetParent?.getBoundingClientRect().height ?? window.innerHeight;
      const height = this.el.getBoundingClientRect().height;
      const y = Math.min(parent - 120, Math.max(parent - height, start.top + dy));
      this.el.style.transform = `translateY(${y - (parent - height)}px)`;
    });
    const end = (e: PointerEvent) => {
      if (!start) return;
      this.el.classList.remove('is-dragging');
      const dy = e.clientY - start.y;
      const v = dy / Math.max(1, performance.now() - start.t);
      start = null;
      if (!moved) {
        // Tippen auf den Griff: eine Stufe weiter
        this.set(this.snap === 'peek' ? 'half' : this.snap === 'half' ? 'full' : 'peek');
        return;
      }
      const order: Snap[] = ['peek', 'half', 'full'];
      let i = order.indexOf(this.snap);
      if (v < -0.4 || dy < -80) i = Math.min(2, i + (dy < -260 ? 2 : 1));
      else if (v > 0.4 || dy > 80) i = Math.max(0, i - (dy > 260 ? 2 : 1));
      this.set(order[i]);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
