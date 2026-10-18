import './style.css';
import { dailyReport, type DailyReport, type Objective } from './sim/analysis.ts';
import { defaultPolicy, simulate } from './sim/engine.ts';
import { ArrivalIndex, activeIncidents as simIncidents, hotspotsAt, trainAt, trainsAt, type TrainState } from './sim/live.ts';
import { buildDayModel, type DayModel } from './sim/model.ts';
import { observedResult, type ObservedStats } from './sim/real.ts';
import type { RealtimeDay } from './realtime/types.ts';
import { INCIDENT_LABEL, causeText, fmtDelay, hhmm, incidentPlace, shortName, tripLabel } from './sim/text.ts';
import type { SimResult, Timetable } from './sim/types.ts';
import { $, delayColor, esc } from './ui/dom.ts';
import { PixelMap } from './ui/map.ts';
import type { MapData } from './ui/mapdata.ts';
import { renderReport } from './ui/report.ts';

/** Ab dieser Uhrzeit beginnt ein neuer Verkehrstag (Nachtzüge laufen über Mitternacht). */
const DAY_ROLLOVER = 180;

interface Day {
  date: string;
  model: DayModel;
  result: SimResult;
  arrivals: ArrivalIndex;
  /** Echtzeitdaten oder, wenn keine vorliegen, Simulation */
  mode: 'real' | 'sim';
  stats?: ObservedStats;
  report?: DailyReport;
}

/** Echtzeitdaten: in Produktion von der Netlify Function, lokal von scripts/collect-realtime.ts. */
async function fetchRealtime(date: string): Promise<RealtimeDay | null> {
  for (const url of [`api/realtime?date=${date}`, `data/realtime/${date}.json`]) {
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok || !r.headers.get('content-type')?.includes('json')) continue;
      const day = (await r.json()) as RealtimeDay;
      if (day.trips && Object.keys(day.trips).length) return day;
    } catch {
      // nächste Quelle versuchen
    }
  }
  return null;
}

const REALTIME_POLL = 60_000;

function berlinNow(): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}${parts.month}${parts.day}`, minutes: +parts.hour * 60 + +parts.minute + +parts.second / 60 };
}

function addDays(yyyymmdd: string, n: number): string {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + n));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

/** Verkehrstag und Minute im Verkehrstag für die aktuelle Uhrzeit. */
function serviceNow() {
  const now = berlinNow();
  return now.minutes < DAY_ROLLOVER ? { date: addDays(now.date, -1), minutes: now.minutes + 1440 } : now;
}

const fmtDate = (d: string) =>
  new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

async function main() {
  const [tt, mapData] = await Promise.all([
    fetch('data/timetable.json').then((r) => r.json() as Promise<Timetable>),
    fetch('data/map.json').then((r) => r.json() as Promise<MapData>),
  ]);

  const days = new Map<string, Day>();
  /** Lädt Echtzeitdaten nach; true, wenn sich etwas geändert hat. */
  const refreshRealtime = async (d: Day): Promise<boolean> => {
    const rt = await fetchRealtime(d.date);
    if (!rt || (d.stats && rt.feedTime <= d.stats.feedTime)) return false;
    const { result, stats } = observedResult(d.model, rt);
    Object.assign(d, { result, stats, mode: 'real', arrivals: new ArrivalIndex(d.model, result), report: undefined });
    return true;
  };
  const loadDay = async (date: string): Promise<Day> => {
    let d = days.get(date);
    if (!d) {
      const model = buildDayModel(tt, date);
      const result = simulate(model, defaultPolicy());
      d = { date, model, result, arrivals: new ArrivalIndex(model, result), mode: 'sim' };
      days.set(date, d);
      await refreshRealtime(d);
    }
    return d;
  };

  const state = {
    day: await loadDay(serviceNow().date),
    live: true,
    playing: true,
    speed: 60,
    time: serviceNow().minutes,
    selectedTrain: undefined as number | undefined,
    selectedStation: undefined as number | undefined,
  };

  const canvas = $<HTMLCanvasElement>('map');
  const map = new PixelMap(canvas, mapData, state.day.model);
  const scrub = $<HTMLInputElement>('scrub');

  // --- Zeitsteuerung ---------------------------------------------------------
  const speedButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-speed]')];
  const syncControls = () => {
    const today = serviceNow().date;
    $('day-today').classList.toggle('is-active', state.day.date === today);
    $('day-yesterday').classList.toggle('is-active', state.day.date === addDays(today, -1));
    $('go-live').classList.toggle('is-active', state.live);
    $('play').textContent = state.playing ? '❚❚' : '▶';
    $('play').setAttribute('aria-label', state.playing ? 'Pause' : 'Abspielen');
    speedButtons.forEach((b) => b.classList.toggle('is-active', !state.live && +b.dataset.speed! === state.speed));
    const mode = $('clock-mode');
    mode.textContent = state.live ? 'LIVE' : `ZEITRAFFER · ${fmtDate(state.day.date)}`;
    mode.classList.toggle('is-replay', !state.live);
  };

  const switchDay = async (date: string) => {
    state.day = await loadDay(date);
    map.setModel(state.day.model);
    state.selectedTrain = state.selectedStation = undefined;
    renderNotice();
  };

  const goLive = async () => {
    const now = serviceNow();
    if (state.day.date !== now.date) await switchDay(now.date);
    state.live = true;
    state.playing = true;
    state.time = now.minutes;
    syncControls();
  };

  const toReplay = () => {
    state.live = false;
    syncControls();
  };

  speedButtons.forEach((b) =>
    b.addEventListener('click', () => {
      state.speed = +b.dataset.speed!;
      state.playing = true;
      toReplay();
    }),
  );
  $('play').addEventListener('click', () => {
    if (state.live) state.live = false;
    state.playing = !state.playing;
    syncControls();
  });
  $('go-live').addEventListener('click', goLive);
  scrub.addEventListener('input', () => {
    state.time = +scrub.value;
    toReplay();
  });
  $('day-today').addEventListener('click', goLive);
  $('day-yesterday').addEventListener('click', async () => {
    await switchDay(addDays(serviceNow().date, -1));
    state.time = 6 * 60;
    state.speed = 300;
    state.playing = true;
    toReplay();
  });

  // --- Karte: Zoom, Pan, Auswahl ---------------------------------------------
  let drag: { x: number; y: number; moved: boolean } | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    drag = { x: e.offsetX, y: e.offsetY, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) {
        const [mx, my] = map.toMapPixel((a.x + b.x) / 2, (a.y + b.y) / 2);
        map.zoomAt(d / pinchDist, mx, my);
      }
      pinchDist = d;
      if (drag) drag.moved = true;
      return;
    }
    if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      if (drag.moved || Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        canvas.classList.add('is-dragging');
        const [mx0, my0] = map.toMapPixel(drag.x, drag.y);
        const [mx1, my1] = map.toMapPixel(e.offsetX, e.offsetY);
        map.pan(mx0 - mx1, my0 - my1);
        drag.x = e.offsetX;
        drag.y = e.offsetY;
      }
      return;
    }
    hover(e.offsetX, e.offsetY);
  });
  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (drag && !drag.moved && pointers.size === 0) {
      const [mx, my] = map.toMapPixel(e.offsetX, e.offsetY);
      const hit = map.hitTest(mx, my);
      state.selectedTrain = hit?.type === 'train' ? hit.id : undefined;
      state.selectedStation = hit?.type === 'station' ? hit.id : undefined;
      renderSelection();
    }
    if (pointers.size === 0) drag = null;
    canvas.classList.remove('is-dragging');
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => ($('tooltip').hidden = true));
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [mx, my] = map.toMapPixel(e.offsetX, e.offsetY);
      map.zoomAt(e.deltaY < 0 ? 1.25 : 0.8, mx, my);
    },
    { passive: false },
  );
  $('zoom-in').addEventListener('click', () => map.zoomAt(1.4, map.w / 2, map.h / 2));
  $('zoom-out').addEventListener('click', () => map.zoomAt(1 / 1.4, map.w / 2, map.h / 2));
  $('zoom-reset').addEventListener('click', () => {
    map.zoom = 1;
    map.focus(10.45, 51.15);
  });

  const tooltip = $('tooltip');
  function hover(cssX: number, cssY: number) {
    const [mx, my] = map.toMapPixel(cssX, cssY);
    const hit = map.hitTest(mx, my);
    if (!hit) {
      tooltip.hidden = true;
      return;
    }
    const m = state.day.model;
    if (hit.type === 'train') {
      const s = trainAt(m, state.day.result, hit.id, state.time);
      tooltip.innerHTML = `${esc(tripLabel(m, hit.id))} <b style="color:${delayColor(s?.delay ?? 0)}">${fmtDelay(s?.delay ?? 0)}</b>`;
    } else tooltip.textContent = m.stations[hit.id].name;
    tooltip.style.left = `${cssX}px`;
    tooltip.style.top = `${cssY}px`;
    tooltip.hidden = false;
  }

  // --- Seitenleiste ----------------------------------------------------------
  const selectTrain = (trip: number) => {
    state.selectedTrain = trip;
    state.selectedStation = undefined;
    renderSelection();
    $('selection-panel').scrollIntoView({ block: 'nearest' });
  };

  function renderSelection() {
    const panel = $('selection-panel');
    const box = $('selection');
    const m = state.day.model;
    const r = state.day.result;
    if (state.selectedTrain !== undefined) {
      const id = state.selectedTrain;
      const T = m.trips[id];
      const R = r.trips[id];
      const s = trainAt(m, r, id, state.time);
      const now = state.time;
      $('sel-title').textContent = T.line;
      const causes =
        state.day.mode === 'real'
          ? delayBuildup(id).filter((b) => b.at <= now + 0.01).map((b) => b.text)
          : R.causes
              .flatMap((cs, i) => cs.map((c) => ({ c, i })))
              .filter(({ c, i }) => c.minutes >= 1 && (i === 0 ? R.dep[0] : R.arr[i]) <= now + 0.01)
              .map(({ c }) => causeText(m, c));
      box.innerHTML = `
        <div class="sel-meta">${esc(shortName(m.stations[T.stops[0]].name))} → ${esc(shortName(m.stations[T.stops[T.stops.length - 1]].name))} · ${esc(T.operator)}</div>
        <div class="sel-delay" style="color:${R.known === false ? 'var(--muted)' : delayColor(s?.delay ?? 0)}">${R.canceled ? 'fällt aus' : R.known === false ? 'keine Echtzeitdaten' : s ? `${fmtDelay(s.delay)} Min` : now < R.dep[0] ? 'noch nicht abgefahren' : 'angekommen'}</div>
        ${causes.length ? `<ul class="causes">${causes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
        <ol class="stops">
          ${T.stops
            .map((st, i) => {
              const sched = i === 0 ? T.schedDep[i] : T.schedArr[i];
              const act = i === 0 ? R.dep[i] : R.arr[i];
              const d = act - sched;
              const past = act <= now;
              const isNow = s && s.stop === i;
              if (R.known === false) return `<li class="${act <= now ? 'is-past' : ''} ${isNow ? 'is-now' : ''}"><span class="dot"></span><span>${esc(shortName(m.stations[st].name))}</span><span class="t">${hhmm(sched)}</span><span class="t"></span></li>`;
              return `<li class="${past ? 'is-past' : ''} ${isNow ? 'is-now' : ''}"><span class="dot"></span><span>${esc(shortName(m.stations[st].name))}</span><span class="t">${hhmm(sched)}</span><span class="t" style="color:${delayColor(d)}">${past || isNow ? fmtDelay(d) : ''}</span></li>`;
            })
            .join('')}
        </ol>`;
      panel.hidden = false;
    } else if (state.selectedStation !== undefined) {
      const st = state.selectedStation;
      $('sel-title').textContent = shortName(m.stations[st].name);
      const deps: { trip: number; sched: number; act: number; to: string }[] = [];
      for (const T of m.trips) {
        const i = T.stops.indexOf(st);
        if (i < 0 || i === T.stops.length - 1) continue;
        const act = r.trips[T.id].dep[i];
        if (act < state.time - 1 || T.schedDep[i] > state.time + 90) continue;
        deps.push({ trip: T.id, sched: T.schedDep[i], act, to: shortName(m.stations[T.stops[T.stops.length - 1]].name) });
      }
      deps.sort((a, b) => a.sched - b.sched);
      box.innerHTML = `<div class="sel-meta">Abfahrten der nächsten 90 Minuten</div>
        <ul class="list">${
          deps.length
            ? deps
                .slice(0, 14)
                .map(
                  (d) => `<li data-trip="${d.trip}"><span class="t">${hhmm(d.sched)}</span><span class="badge" style="background:${delayColor(d.act - d.sched)}">${fmtDelay(d.act - d.sched)}</span><span>${esc(m.trips[d.trip].line)} <span class="meta">nach ${esc(d.to)}</span></span></li>`,
                )
                .join('')
            : '<li class="empty">Keine Abfahrten</li>'
        }</ul>`;
      panel.hidden = false;
    } else panel.hidden = true;
  }
  /** Echte Daten: wo ist die Verspätung entstanden? (Zuwachs je Abschnitt und Halt) */
  function delayBuildup(id: number): { at: number; text: string }[] {
    const m = state.day.model;
    const T = m.trips[id];
    const R = state.day.result.trips[id];
    const name = (i: number) => shortName(m.stations[T.stops[i]].name);
    const out: { at: number; text: string }[] = [];
    const d0 = R.dep[0] - T.schedDep[0];
    if (d0 >= 2) out.push({ at: R.dep[0], text: `+${Math.round(d0)} Min schon bei Abfahrt in ${name(0)}` });
    for (let i = 0; i + 1 < T.stops.length; i++) {
      const run = R.arr[i + 1] - T.schedArr[i + 1] - (R.dep[i] - T.schedDep[i]);
      if (run >= 2) out.push({ at: R.arr[i + 1], text: `+${Math.round(run)} Min zwischen ${name(i)} und ${name(i + 1)}` });
      else if (run <= -2) out.push({ at: R.arr[i + 1], text: `${Math.round(run)} Min aufgeholt bis ${name(i + 1)}` });
      if (i + 1 < T.stops.length - 1) {
        const dwell = R.dep[i + 1] - T.schedDep[i + 1] - (R.arr[i + 1] - T.schedArr[i + 1]);
        if (dwell >= 2) out.push({ at: R.dep[i + 1], text: `+${Math.round(dwell)} Min beim Halt in ${name(i + 1)}` });
      }
    }
    return out;
  }

  $('selection').addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-trip]');
    if (li) selectTrain(+li.dataset.trip!);
  });
  $('sel-close').addEventListener('click', () => {
    state.selectedTrain = state.selectedStation = undefined;
    renderSelection();
  });

  /** Simulierte Störungen gibt es nur im Simulationsmodus. */
  const activeIncidents = (m: DayModel, t: number) => (state.day.mode === 'real' ? [] : simIncidents(m, t));
  const severity = (k: string) => ['oberleitung', 'personen', 'notarzt', 'signal', 'weiche', 'fahrzeug', 'bau'].indexOf(k);
  function renderPanels(trains: TrainState[]) {
    const m = state.day.model;
    const sofar = state.day.arrivals.until(state.time);
    $('kpi-punct').textContent = sofar.arrivals ? `${(sofar.punctuality * 100).toFixed(1).replace('.', ',')}%` : '–';
    $('kpi-punct').style.color = sofar.arrivals ? delayColor(sofar.punctuality > 0.8 ? 0 : sofar.punctuality > 0.7 ? 10 : sofar.punctuality > 0.6 ? 20 : 40) : '';
    $('kpi-active').textContent = String(trains.length);
    const knownTrains = trains.filter((t) => t.known);
    const avg = knownTrains.length ? knownTrains.reduce((s, t) => s + t.delay, 0) / knownTrains.length : 0;
    $('kpi-delay').textContent = knownTrains.length ? `${avg.toFixed(1).replace('.', ',')}′` : '–';
    const real = state.day.mode === 'real';
    $('kpi-incidents-label').textContent = real ? 'Brennpunkte' : 'Störungen';
    $('kpi-incidents-hint').textContent = real ? 'letzte 60 Min' : 'aktiv';
    $('incidents-title').textContent = real ? 'Brennpunkte · letzte 60 Min' : 'Störungen jetzt';
    if (real) {
      // Echte Daten enthalten keine Störungsmeldungen – stattdessen: wo wächst die Verspätung gerade?
      const hs = hotspotsAt(m, state.day.result, state.time);
      $('kpi-incidents').textContent = String(hs.length);
      $('incidents').innerHTML = hs.length
        ? hs
            .slice(0, 7)
            .map((h) => {
              const st = m.stations[h.station];
              return `<li data-lon="${st.lon}" data-lat="${st.lat}"><span class="badge" style="background:${delayColor(h.minutes / Math.max(1, h.trains) * 3)}">+${Math.round(h.minutes)}</span><span>${esc(shortName(st.name))} <span class="meta">${h.trains} ${h.trains === 1 ? 'Zug' : 'Züge'} haben hier Zeit verloren</span></span></li>`;
            })
            .join('')
        : '<li class="empty">Gerade baut sich nirgends Verspätung auf</li>';
    }
    const incs = real ? [] : activeIncidents(m, state.time).sort((a, b) => severity(a.kind) - severity(b.kind));
    if (!real) $('kpi-incidents').textContent = String(incs.length);
    const acute = incs.filter((i) => i.kind !== 'bau');
    const works = incs.filter((i) => i.kind === 'bau');
    if (!real) $('incidents').innerHTML =
      acute
        .map(
          (i) => `<li data-lon="${i.lon}" data-lat="${i.lat}"><span class="badge" style="background:${i.blocking ? '#f43f5e' : '#facc15'}">${i.blocking ? 'STOP' : '!'}</span><span>${INCIDENT_LABEL[i.kind]} <span class="meta">${esc(incidentPlace(m, i))} · bis ${hhmm(i.end)}</span></span></li>`,
        )
        .join('') +
        (works.length
          ? `<li data-works="1"><span class="badge" style="background:#fb923c">BAU</span><span>${works.length} Langsamfahrstellen <span class="meta">${works
              .slice(0, 4)
              .map((i) => esc(incidentPlace(m, i)))
              .join(' · ')}${works.length > 4 ? ' …' : ''}</span></span></li>`
          : '') || '<li class="empty">Keine Störungen</li>';
    const worst = knownTrains.sort((a, b) => b.delay - a.delay).slice(0, 7);
    $('worst').innerHTML = worst.length
      ? worst
          .map(
            (t) => `<li data-trip="${t.trip}"><span class="badge" style="background:${delayColor(t.delay)}">${fmtDelay(t.delay)}</span><span>${esc(tripLabel(m, t.trip))}</span></li>`,
          )
          .join('')
      : '<li class="empty">Gerade kein Zug unterwegs</li>';
    if (state.selectedTrain !== undefined || state.selectedStation !== undefined) renderSelection();
  }
  $('worst').addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-trip]');
    if (li) selectTrain(+li.dataset.trip!);
  });
  let worksCursor = 0;
  $('incidents').addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-lon], [data-works]');
    if (!li) return;
    if (li.dataset.works) {
      // Klick springt reihum von Baustelle zu Baustelle
      const works = activeIncidents(state.day.model, state.time).filter((i) => i.kind === 'bau');
      if (!works.length) return;
      const w = works[worksCursor++ % works.length];
      map.focus(w.lon, w.lat, Math.max(map.zoom, 3));
    } else map.focus(+li.dataset.lon!, +li.dataset.lat!, Math.max(map.zoom, 3));
  });

  // --- Tagesbericht ----------------------------------------------------------
  const dialog = $<HTMLDialogElement>('report');
  let objective: Objective = 'punctuality';
  const showReport = () => {
    const day = state.day;
    const partial = day.date === serviceNow().date;
    $('report-body').innerHTML = renderReport(day.model, day.report!, { partial, objective, observed: day.mode === 'real' ? day.result : undefined });
  };
  $('open-report').addEventListener('click', () => {
    const day = state.day;
    $('report-title').textContent = `Tagesbericht · ${fmtDate(day.date)}`;
    dialog.showModal();
    if (day.report) return showReport();
    $('report-body').innerHTML = `<div class="loading">Der Leitstand spielt alternative Entscheidungen durch …<div class="loading-bar"></div></div>`;
    // Erst rendern lassen, dann rechnen
    setTimeout(() => {
      day.report = dailyReport(day.model, day.mode === 'real' ? { observed: day.result } : {});
      showReport();
    }, 60);
  });
  $('report-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  $('report-body').addEventListener('click', (e) => {
    const o = (e.target as HTMLElement).closest<HTMLElement>('[data-objective]');
    if (o) {
      objective = o.dataset.objective as Objective;
      return showReport();
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-show-trip]');
    if (!b) return;
    dialog.close();
    state.time = +b.dataset.showTime!;
    state.speed = 60;
    state.playing = true;
    toReplay();
    selectTrain(+b.dataset.showTrip!);
    // Zug ins Bild holen
    const T = state.day.model.trips[+b.dataset.showTrip!];
    const s = trainAt(state.day.model, state.day.result, T.id, state.time);
    const st = state.day.model.stations[T.stops[s?.stop ?? 0]];
    map.focus(st.lon, st.lat, Math.max(map.zoom, 3));
  });

  // --- Hauptschleife ---------------------------------------------------------
  let last = performance.now();
  let lastPanel = 0;
  const loop = (now: number) => {
    const dt = Math.min(250, now - last);
    last = now;
    if (state.live) {
      const sn = serviceNow();
      if (sn.date !== state.day.date) switchDay(sn.date);
      state.time = sn.minutes;
    } else if (state.playing) {
      state.time += (dt / 60000) * state.speed;
      if (state.time > 1440 + DAY_ROLLOVER) {
        state.time = 1440 + DAY_ROLLOVER;
        state.playing = false;
        syncControls();
      }
    }
    const trains = trainsAt(state.day.model, state.day.result, state.time);
    map.draw(trains, activeIncidents(state.day.model, state.time), { train: state.selectedTrain, station: state.selectedStation }, Math.floor(now / 400) % 2 === 0);
    $('clock').textContent = hhmm(state.time);
    if (document.activeElement !== scrub) scrub.value = String(Math.round(state.time));
    if (now - lastPanel > 400) {
      lastPanel = now;
      renderPanels(trains);
    }
    requestAnimationFrame(loop);
  };

  function renderNotice() {
    const d = state.day;
    const stale = d.model.timetableDate !== d.date ? ` Fahrplan-Stand ${fmtDate(d.model.timetableDate)} (gleicher Wochentag), bitte Daten aktualisieren.` : '';
    if (d.mode === 'real' && d.stats) {
      const st = d.stats;
      const time = new Date(st.feedTime * 1000).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
      $('notice').innerHTML = `<strong class="is-real">Echtzeitdaten</strong> Stand ${time} · ${st.known} Fahrten mit Ist-Daten${st.canceled ? ` · ${st.canceled} Ausfälle` : ''} · ${st.unknown} Fahrten ohne Meldung (grau, nach Fahrplan).${stale}`;
    } else {
      $('notice').innerHTML = `<strong>Simulation</strong> Für diesen Tag liegen keine Echtzeitdaten vor. Der Fahrplan ist echt, Störungen und Verspätungen sind simuliert.${stale}`;
    }
    $('clock-mode').dataset.source = d.mode;
  }
  setInterval(async () => {
    const d = state.day;
    if (d.date !== serviceNow().date) return;
    if (await refreshRealtime(d)) {
      if (state.day === d) renderNotice();
    }
  }, REALTIME_POLL);

  renderNotice();
  syncControls();
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<p style="padding:16px;color:#f43f5e">Fehler beim Laden: ${esc(String(err))}</p>`);
});
