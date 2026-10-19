export type Snap = 'peek' | 'half' | 'full';

const ORDER: Snap[] = ['peek', 'half', 'full'];

/**
 * Bottom-Sheet auf dem Handy: ziehen am Griff oder Statusbereich, rastet auf drei Höhen ein.
 * Im Inhalt gilt wie bei Karten-Apps: ganz oben nach unten wischen schiebt das Sheet zu,
 * nach oben wischen zieht es zuerst ganz auf und scrollt erst dann.
 * Auf breiten Bildschirmen ist das Sheet eine feste Seitenleiste (CSS), Ziehen ist dann aus.
 */
export class Sheet {
  snap: Snap = 'peek';
  private listeners: ((s: Snap) => void)[] = [];
  private drag: { y: number; top: number; base: number; t: number; moved: boolean } | null = null;

  constructor(private el: HTMLElement, handles: HTMLElement[], body?: HTMLElement) {
    for (const h of handles) this.bindDrag(h);
    if (body) this.bindBody(body);
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

  // --- Ziehen ------------------------------------------------------------------

  private begin(y: number) {
    // base: Oberkante ohne Verschiebung (auf dem Handy sitzt das Sheet über der App-Navigation)
    this.drag = { y, top: this.el.getBoundingClientRect().top, base: this.el.offsetTop, t: performance.now(), moved: false };
  }

  private move(y: number) {
    const d = this.drag;
    if (!d) return;
    const dy = y - d.y;
    if (!d.moved && Math.abs(dy) < 6) return;
    d.moved = true;
    this.el.classList.add('is-dragging');
    const height = this.el.offsetHeight;
    const top = Math.min(d.base + height - 120, Math.max(d.base, d.top + dy));
    this.el.style.transform = `translateY(${top - d.base}px)`;
  }

  /** Loslassen: je nach Weg und Schwung eine oder zwei Stufen weiter; Tippen schaltet eine Stufe */
  private end(y: number, tapSteps: boolean) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    this.el.classList.remove('is-dragging');
    if (!d.moved) {
      if (tapSteps) this.set(this.snap === 'peek' ? 'half' : this.snap === 'half' ? 'full' : 'peek');
      return;
    }
    const dy = y - d.y;
    const v = dy / Math.max(1, performance.now() - d.t);
    let i = ORDER.indexOf(this.snap);
    if (v < -0.4 || dy < -80) i = Math.min(2, i + (dy < -260 ? 2 : 1));
    else if (v > 0.4 || dy > 80) i = Math.max(0, i - (dy > 260 ? 2 : 1));
    this.set(ORDER[i]);
  }

  /**
   * Übernimmt eine laufende Geste von einem anderen Element (z. B. senkrechtes Wischen auf der
   * Zeitleiste). startY ist der Punkt, an dem der Finger aufgesetzt hat.
   */
  takeOver(e: PointerEvent, startY: number, from: HTMLElement) {
    if (this.docked) return;
    this.begin(startY);
    this.move(e.clientY);
    from.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => this.move(ev.clientY);
    const done = (ev: PointerEvent) => {
      from.removeEventListener('pointermove', move);
      from.removeEventListener('pointerup', done);
      from.removeEventListener('pointercancel', done);
      this.end(ev.clientY, false);
    };
    from.addEventListener('pointermove', move);
    from.addEventListener('pointerup', done);
    from.addEventListener('pointercancel', done);
  }

  private bindDrag(handle: HTMLElement) {
    let active = false;
    handle.addEventListener('pointerdown', (e) => {
      if (this.docked || (e.target as HTMLElement).closest('button')) return;
      active = true;
      this.begin(e.clientY);
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => active && this.move(e.clientY));
    const end = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      this.end(e.clientY, true);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /** Wischen im scrollbaren Inhalt (Touch): Sheet bewegen statt scrollen, wo das sinnvoll ist */
  private bindBody(body: HTMLElement) {
    let start: { x: number; y: number } | null = null;
    let mode: 'sheet' | 'scroll' | null = null;
    body.addEventListener(
      'touchstart',
      (e) => {
        if (this.docked || e.touches.length !== 1) return;
        start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        mode = null;
      },
      { passive: true },
    );
    body.addEventListener(
      'touchmove',
      (e) => {
        if (!start || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = t.clientX - start.x, dy = t.clientY - start.y;
        if (!mode) {
          if (Math.hypot(dx, dy) < 8) return;
          const vertical = Math.abs(dy) > Math.abs(dx);
          // Nach unten nur, wenn der Inhalt ganz oben ist; nach oben, solange das Sheet nicht ganz offen ist
          const pullDown = dy > 0 && body.scrollTop <= 0 && this.snap !== 'peek';
          const pullUp = dy < 0 && this.snap !== 'full';
          mode = vertical && (pullDown || pullUp) && !(e.target as HTMLElement).closest('input, select, textarea, canvas') ? 'sheet' : 'scroll';
          if (mode === 'sheet') this.begin(start.y);
        }
        if (mode === 'sheet') {
          e.preventDefault();
          this.move(t.clientY);
        }
      },
      { passive: false },
    );
    const end = (e: TouchEvent) => {
      if (mode === 'sheet') this.end(e.changedTouches[0]?.clientY ?? 0, false);
      start = null;
      mode = null;
    };
    body.addEventListener('touchend', end);
    body.addEventListener('touchcancel', end);
  }
}
