import './style.css';
import { dailyReport, type DailyReport, type Objective } from './sim/analysis.ts';
import { defaultPolicy, simulate } from './sim/engine.ts';
import { ArrivalIndex, activeIncidents as simIncidents, hotspotsAt, hourlyPunctuality, trainAt, trainsAt, type LiveHotspot, type TrainState } from './sim/live.ts';
import { buildDayModel, type DayModel } from './sim/model.ts';
import { observedResult, type ObservedStats } from './sim/real.ts';
import type { RealtimeDay } from './realtime/types.ts';
import { causeText, fmtDelay, hhmm, shortName, tripLabel } from './sim/text.ts';
import type { SimResult, Timetable } from './sim/types.ts';
import { $, delayColor, esc } from './ui/dom.ts';
import { PixelMap } from './ui/map.ts';
import type { MapData } from './ui/mapdata.ts';
import { gradeOf, renderReport } from './ui/report.ts';
import { Sheet } from './ui/sheet.ts';
import { Timeline } from './ui/timeline.ts';
import { emptyRow, hotspotRow, incidentRow, stationBoard, trainDetail, trainRow, type Buildup } from './ui/views.ts';

/** Ab dieser Uhrzeit beginnt ein neuer Verkehrstag (Nachtzüge laufen über Mitternacht). */
const DAY_ROLLOVER = 180;
const REALTIME_POLL = 60_000;
const SPEEDS = [1, 60, 300, 1200];

interface Day {
  date: string;
  model: DayModel;
  result: SimResult;
  arrivals: ArrivalIndex;
  bins: { arrivals: number; punctual: number }[];
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

const punctColor = (p: number) => delayColor(p > 0.85 ? 0 : p > 0.7 ? 10 : p > 0.55 ? 20 : 40);

async function main() {
  const [tt, mapData] = await Promise.all([
    fetch('data/timetable.json').then((r) => r.json() as Promise<Timetable>),
    fetch('data/map.json').then((r) => r.json() as Promise<MapData>),
  ]);

  // --- Verkehrstage ----------------------------------------------------------
  const days = new Map<string, Day>();
  /** Lädt Echtzeitdaten nach; true, wenn sich etwas geändert hat. */
  const refreshRealtime = async (d: Day): Promise<boolean> => {
    const rt = await fetchRealtime(d.date);
    if (!rt || (d.stats && rt.feedTime <= d.stats.feedTime)) return false;
    const { result, stats } = observedResult(d.model, rt);
    Object.assign(d, { result, stats, mode: 'real', arrivals: new ArrivalIndex(d.model, result), bins: hourlyPunctuality(d.model, result), report: undefined });
    return true;
  };
  const loadDay = async (date: string): Promise<Day> => {
    let d = days.get(date);
    if (!d) {
      const model = buildDayModel(tt, date);
      const result = simulate(model, defaultPolicy());
      d = { date, model, result, arrivals: new ArrivalIndex(model, result), bins: hourlyPunctuality(model, result), mode: 'sim' };
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
    tab: 'now' as 'now' | 'trains' | 'report',
    hotspots: [] as LiveHotspot[],
  };

  const canvas = $<HTMLCanvasElement>('map');
  const map = new PixelMap(canvas, $<HTMLCanvasElement>('glow'), mapData, state.day.model);
  const sheet = new Sheet($('sheet'), [$('sheet-grab'), document.querySelector<HTMLElement>('.status')!]);
  const timeline = new Timeline($<HTMLCanvasElement>('strip'), (minute) => {
    state.time = minute;
    state.live = false;
    syncControls();
  });

  /** Simulierte Störungen gibt es nur im Simulationsmodus. */
  const activeIncidents = (m: DayModel, t: number) => (state.day.mode === 'real' ? [] : simIncidents(m, t));

  const layoutMap = () => {
    const hud = document.querySelector<HTMLElement>('.hud')!.getBoundingClientRect();
    const stage = canvas.getBoundingClientRect();
    const peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-peek')) || 236;
    map.setInsets(hud.bottom - stage.top + 4, sheet.docked ? 0 : peek);
  };
  window.addEventListener('resize', layoutMap);

  // --- Zeitsteuerung ---------------------------------------------------------
  const syncControls = () => {
    const today = serviceNow().date;
    $('day-today').classList.toggle('is-active', state.day.date === today);
    $('day-yesterday').classList.toggle('is-active', state.day.date === addDays(today, -1));
    $('go-live').classList.toggle('is-replay', !state.live);
    $('clock-mode').textContent = state.live ? 'Live' : `${fmtDate(state.day.date)}`;
    $('play').textContent = state.playing ? '❚❚' : '▶';
    $('play').setAttribute('aria-label', state.playing ? 'Pause' : 'Abspielen');
    $('speed').textContent = state.live ? 'Live' : `${state.speed}×`;
  };

  const switchDay = async (date: string) => {
    state.day = await loadDay(date);
    map.setModel(state.day.model);
    closeDetail();
    renderPanels(trainsAt(state.day.model, state.day.result, state.time));
  };

  const goLive = async () => {
    const now = serviceNow();
    if (state.day.date !== now.date) await switchDay(now.date);
    state.live = true;
    state.playing = true;
    state.time = now.minutes;
    syncControls();
  };

  $('go-live').addEventListener('click', goLive);
  $('day-today').addEventListener('click', goLive);
  $('day-yesterday').addEventListener('click', async () => {
    await switchDay(addDays(serviceNow().date, -1));
    state.time = 6 * 60;
    state.speed = 300;
    state.playing = true;
    state.live = false;
    syncControls();
  });
  $('play').addEventListener('click', () => {
    if (state.live) state.live = false;
    state.playing = !state.playing;
    syncControls();
  });
  $('speed').addEventListener('click', () => {
    if (state.live) {
      state.live = false;
      state.speed = 60;
    } else state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
    state.playing = true;
    syncControls();
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
      if (drag.moved || Math.hypot(dx, dy) > 5) {
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
    if (e.pointerType === 'mouse') hover(e.offsetX, e.offsetY);
  });
  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (drag && !drag.moved && pointers.size === 0) {
      const [mx, my] = map.toMapPixel(e.offsetX, e.offsetY);
      const hit = map.hitTest(mx, my);
      if (hit?.type === 'train') selectTrain(hit.id, false);
      else if (hit?.type === 'station') selectStation(hit.id);
      else closeDetail();
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
      map.zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, mx, my);
    },
    { passive: false },
  );
  $('zoom-in').addEventListener('click', () => map.zoomAt(1.5, map.w / 2, map.h / 2));
  $('zoom-out').addEventListener('click', () => map.zoomAt(1 / 1.5, map.w / 2, map.h / 2));
  $('zoom-reset').addEventListener('click', () => map.reset());

  const tooltip = $('tooltip');
  function hover(cssX: number, cssY: number) {
    const [mx, my] = map.toMapPixel(cssX, cssY);
    const hit = map.hitTest(mx, my);
    if (!hit) {
      tooltip.hidden = true;
      canvas.style.cursor = '';
      return;
    }
    canvas.style.cursor = 'pointer';
    const m = state.day.model;
    if (hit.type === 'train') {
      const s = trainAt(m, state.day.result, hit.id, state.time);
      tooltip.innerHTML = `${esc(tripLabel(m, hit.id))} <b style="color:${s?.known ? delayColor(s.delay) : 'var(--nodata)'}">${s?.known ? fmtDelay(s.delay) : '–'}</b>`;
    } else tooltip.textContent = shortName(m.stations[hit.id].name);
    tooltip.style.left = `${cssX}px`;
    tooltip.style.top = `${cssY}px`;
    tooltip.hidden = false;
  }

  // --- Ansichten im Sheet ----------------------------------------------------
  const views = { now: $('view-now'), trains: $('view-trains'), report: $('view-report'), detail: $('view-detail') };
  const showView = (v: keyof typeof views) => {
    for (const [k, el] of Object.entries(views)) el.hidden = k !== v;
    $('sheet').classList.toggle('is-detail', v === 'detail');
    document.querySelector<HTMLElement>('.tabs')!.hidden = v === 'detail';
  };
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab as typeof state.tab;
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.toggle('is-active', t === b);
        t.setAttribute('aria-selected', String(t === b));
      });
      closeDetail();
      if (sheet.snap === 'peek') sheet.set('half');
    }),
  );

  function selectTrain(trip: number, fromList: boolean) {
    state.selectedTrain = trip;
    state.selectedStation = undefined;
    showView('detail');
    renderDetail(true);
    $('sheet-body').scrollTop = 0;
    if (sheet.snap === 'peek') sheet.set('half');
    const m = state.day.model;
    const s = trainAt(m, state.day.result, trip, state.time);
    if (fromList || s) {
      const T = m.trips[trip];
      const a = m.stations[T.stops[s?.stop ?? 0]], b = m.stations[T.stops[Math.min((s?.stop ?? 0) + 1, T.stops.length - 1)]];
      const p = s?.progress ?? 0;
      requestAnimationFrame(() => map.ensureVisible(a.lon + (b.lon - a.lon) * p, a.lat + (b.lat - a.lat) * p, sheet.visibleHeight(), fromList ? 2 : 1));
    }
  }

  function selectStation(station: number) {
    state.selectedStation = station;
    state.selectedTrain = undefined;
    showView('detail');
    renderDetail(true);
    $('sheet-body').scrollTop = 0;
    if (sheet.snap === 'peek') sheet.set('half');
    const st = state.day.model.stations[station];
    requestAnimationFrame(() => map.ensureVisible(st.lon, st.lat, sheet.visibleHeight()));
  }

  function closeDetail() {
    state.selectedTrain = state.selectedStation = undefined;
    showView(state.tab);
  }
  $('detail-back').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('report').hidden) $('report').hidden = true;
    else closeDetail();
  });

  /** Echte Daten: wo ist die Verspätung entstanden? Simulation: Ursachen aus dem Modell. */
  function buildup(id: number): Buildup[] {
    const m = state.day.model;
    const T = m.trips[id];
    const R = state.day.result.trips[id];
    if (R.known === false || R.canceled) return [];
    if (state.day.mode === 'sim') {
      return R.causes.flatMap((cs, i) =>
        cs.filter((c) => c.minutes >= 1).map((c) => ({ at: i === 0 ? R.dep[0] : R.arr[i], minutes: c.minutes, text: causeText(m, c).replace(/^\+\d+ Min /, '') })),
      );
    }
    const name = (i: number) => shortName(m.stations[T.stops[i]].name);
    const out: Buildup[] = [];
    const d0 = R.dep[0] - T.schedDep[0];
    if (d0 >= 2) out.push({ at: R.dep[0], minutes: d0, text: `schon bei Abfahrt in ${name(0)}` });
    for (let i = 0; i + 1 < T.stops.length; i++) {
      const run = R.arr[i + 1] - T.schedArr[i + 1] - (R.dep[i] - T.schedDep[i]);
      if (run >= 2) out.push({ at: R.arr[i + 1], minutes: run, text: `zwischen ${name(i)} und ${name(i + 1)}` });
      else if (run <= -2) out.push({ at: R.arr[i + 1], minutes: run, text: `aufgeholt bis ${name(i + 1)}` });
      if (i + 1 < T.stops.length - 1) {
        const dwell = R.dep[i + 1] - T.schedDep[i + 1] - (R.arr[i + 1] - T.schedArr[i + 1]);
        if (dwell >= 2) out.push({ at: R.dep[i + 1], minutes: dwell, text: `beim Halt in ${name(i + 1)}` });
      }
    }
    return out;
  }

  function renderDetail(force = false) {
    const m = state.day.model, r = state.day.result;
    if (state.selectedTrain !== undefined) {
      const id = state.selectedTrain;
      setHtml('detail', trainDetail(m, r, id, trainAt(m, r, id, state.time), state.time, buildup(id)), force);
    } else if (state.selectedStation !== undefined) {
      setHtml('detail', stationBoard(m, r, state.selectedStation, state.time), force);
    }
  }
  $('detail').addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-trip]');
    if (row) selectTrain(+row.dataset.trip!, true);
  });

  const onRowClick = (e: Event) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-trip], [data-station], [data-lon]');
    if (!row) return;
    if (row.dataset.trip) selectTrain(+row.dataset.trip, true);
    else if (row.dataset.station) selectStation(+row.dataset.station);
    else requestAnimationFrame(() => map.ensureVisible(+row.dataset.lon!, +row.dataset.lat!, sheet.visibleHeight(), 3));
  };
  $('incidents').addEventListener('click', onRowClick);
  $('worst').addEventListener('click', onRowClick);
  $('train-list').addEventListener('click', onRowClick);
  $<HTMLInputElement>('search').addEventListener('input', () => renderPanels(trainsAt(state.day.model, state.day.result, state.time)));

  /** Nur neu schreiben, wenn sich etwas geändert hat und gerade niemand tippt – sonst gehen Taps verloren. */
  let touching = false;
  $('sheet').addEventListener('pointerdown', () => (touching = true));
  window.addEventListener('pointerup', () => setTimeout(() => (touching = false), 50));
  window.addEventListener('pointercancel', () => (touching = false));
  const setHtml = (id: string, html: string, force = false) => {
    const el = $(id);
    if ((touching && !force) || el.dataset.html === html) return;
    el.dataset.html = html;
    el.innerHTML = html;
  };

  function renderPanels(trains: TrainState[]) {
    const d = state.day;
    const m = d.model;
    const real = d.mode === 'real';
    const sofar = d.arrivals.until(state.time);
    const known = trains.filter((t) => t.known);

    // Status
    const gauge = $('gauge');
    gauge.style.setProperty('--p', String(sofar.arrivals ? sofar.punctuality * 100 : 0));
    gauge.style.setProperty('--c', sofar.arrivals ? punctColor(sofar.punctuality) : 'var(--dim)');
    $('kpi-punct').innerHTML = sofar.arrivals ? `${Math.floor(sofar.punctuality * 100)}<small>,${Math.floor((sofar.punctuality * 1000) % 10)}%</small>` : '–';
    const late = known.filter((t) => t.delay >= 15).length;
    const worst = [...known].sort((a, b) => b.delay - a.delay)[0];
    $('status-line').textContent = !trains.length
      ? 'Gerade ist kein Fernverkehrszug unterwegs.'
      : late
        ? `${late} ${late === 1 ? 'Zug' : 'Züge'} mit über 15 Min Verspätung, am stärksten ${m.trips[worst.trip].line} mit ${fmtDelay(worst.delay)}`
        : 'Das Netz läuft gerade stabil.';
    const chip = $('source-chip');
    chip.classList.toggle('is-sim', !real);
    if (real && d.stats) {
      const t = new Date(d.stats.feedTime * 1000).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
      chip.innerHTML = `<b>● Echtzeit</b> Stand ${t} · ${d.stats.known} Züge mit Ist-Daten${d.stats.canceled ? ` · ${d.stats.canceled} Ausfälle` : ''}`;
    } else chip.innerHTML = `<b>● Simulation</b> Für ${fmtDate(d.date)} liegen keine Echtzeitdaten vor`;
    $('kpi-active').textContent = String(trains.length);
    $('kpi-delay').textContent = known.length ? `${(known.reduce((s, t) => s + t.delay, 0) / known.length).toFixed(1).replace('.', ',')}′` : '–';

    // Jetzt
    state.hotspots = hotspotsAt(m, d.result, state.time);
    const incs = activeIncidents(m, state.time);
    $('kpi-incidents-label').textContent = real ? 'Brennpunkte' : 'Störungen';
    $('kpi-incidents').textContent = String(real ? state.hotspots.length : incs.length);
    $('incidents-title').textContent = real ? 'Brennpunkte · letzte 60 Min' : 'Störungen jetzt';
    if (real) setHtml('incidents', state.hotspots.length ? state.hotspots.slice(0, 6).map((h) => hotspotRow(m, h)).join('') : emptyRow('Gerade baut sich nirgends Verspätung auf.'));
    else {
      const acute = incs.filter((i) => i.kind !== 'bau');
      const works = incs.filter((i) => i.kind === 'bau');
      setHtml('incidents', [...acute, ...works.slice(0, 3)].map((i) => incidentRow(m, i)).join('') || emptyRow('Keine Störungen.'));
    }
    const top = [...known].sort((a, b) => b.delay - a.delay).slice(0, 6);
    setHtml('worst', top.length ? top.map((t) => trainRow(m, t)).join('') : emptyRow('Gerade kein Zug unterwegs.'));

    // Züge
    if (!views.trains.hidden) {
      const q = $<HTMLInputElement>('search').value.trim().toLowerCase();
      const list = trains
        .filter((t) => {
          if (!q) return true;
          const T = m.trips[t.trip];
          return T.line.toLowerCase().includes(q) || T.stops.some((s) => m.stations[s].name.toLowerCase().includes(q));
        })
        .sort((a, b) => Number(b.known) - Number(a.known) || b.delay - a.delay)
        .slice(0, 60);
      setHtml('train-list', list.length ? list.map((t) => trainRow(m, t)).join('') : emptyRow(q ? 'Kein Zug unterwegs, der passt.' : 'Gerade kein Zug unterwegs.'));
    }

    // Bericht
    if (!views.report.hidden) {
      const g = gradeOf(sofar.punctuality);
      const teaser = $('report-teaser');
      teaser.style.setProperty('--c', g.color);
      teaser.innerHTML = `<span class="teaser-grade">${sofar.arrivals ? g.grade : '–'}</span><span><span class="eyebrow">Stand ${hhmm(state.time)} · ${fmtDate(d.date)}</span><br>${sofar.arrivals ? esc(g.text) : 'Noch keine Ankünfte.'}</span>`;
    }

    if (!views.detail.hidden) renderDetail();
    timeline.setData(d.bins, d.date === serviceNow().date ? serviceNow().minutes : Infinity);
  }

  // --- Tagesbericht ----------------------------------------------------------
  const overlay = $('report');
  let objective: Objective = 'punctuality';
  let objectiveChosen = false;
  const showReport = () => {
    const day = state.day;
    const out = renderReport(day.model, day.report!, { partial: day.date === serviceNow().date, objective, observed: day.mode === 'real' ? day.result : undefined });
    $('report-body').innerHTML = out.html;
    overlay.style.setProperty('--c', out.color);
  };
  $('open-report').addEventListener('click', () => {
    const day = state.day;
    $('report-title').textContent = fmtDate(day.date);
    overlay.hidden = false;
    if (day.report) return showReport();
    $('report-body').innerHTML = `<div class="loading">Der Leitstand spielt den Tag mit anderen Entscheidungen nach …<div class="loading-bar"></div></div>`;
    setTimeout(() => {
      day.report = dailyReport(day.model, day.mode === 'real' ? { observed: day.result } : {});
      // Ohne Pünktlichkeits-Hebel mit dem Fahrgast-Ziel öffnen, damit der Bericht nicht leer startet
      if (!objectiveChosen) objective = day.report.suggestions.some((s) => s.punctualityDelta > 0) ? 'punctuality' : 'passengers';
      if (!overlay.hidden) showReport();
    }, 80);
  });
  $('report-close').addEventListener('click', () => (overlay.hidden = true));
  $('report-body').addEventListener('click', (e) => {
    const o = (e.target as HTMLElement).closest<HTMLElement>('[data-objective]');
    if (o) {
      objective = o.dataset.objective as Objective;
      objectiveChosen = true;
      return showReport();
    }
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-show-trip]');
    if (!b) return;
    overlay.hidden = true;
    state.time = +b.dataset.showTime!;
    state.speed = 60;
    state.playing = true;
    state.live = false;
    syncControls();
    selectTrain(+b.dataset.showTrip!, true);
  });

  // --- Echtzeit nachladen ----------------------------------------------------
  setInterval(async () => {
    const d = state.day;
    if (d.date === serviceNow().date && (await refreshRealtime(d))) renderPanels(trainsAt(d.model, d.result, state.time));
  }, REALTIME_POLL);

  // --- Hauptschleife ---------------------------------------------------------
  let last = performance.now();
  let lastPanel = 0;
  const loop = (now: number) => {
    const dt = Math.min(250, now - last);
    last = now;
    if (state.live) {
      const sn = serviceNow();
      if (sn.date !== state.day.date) void switchDay(sn.date);
      state.time = sn.minutes;
    } else if (state.playing) {
      state.time += (dt / 60000) * state.speed;
      if (state.time > 1440 + DAY_ROLLOVER) {
        state.time = 1440 + DAY_ROLLOVER;
        state.playing = false;
        syncControls();
      }
    }
    const d = state.day;
    const trains = trainsAt(d.model, d.result, state.time);
    if (now - lastPanel > 500) {
      lastPanel = now;
      renderPanels(trains);
    }
    const maxHot = Math.max(30, ...state.hotspots.map((h) => h.minutes));
    map.draw({
      trains,
      incidents: activeIncidents(d.model, state.time),
      hotspots: state.hotspots.slice(0, 8).map((h) => ({ station: h.station, intensity: h.minutes / maxHot })),
      selected: { train: state.selectedTrain, station: state.selectedStation },
      minute: state.time,
      now,
    });
    timeline.draw(state.time);
    $('clock').textContent = hhmm(state.time);
    requestAnimationFrame(loop);
  };

  layoutMap();
  syncControls();
  renderPanels(trainsAt(state.day.model, state.day.result, state.time));
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<p style="position:fixed;z-index:99;padding:16px;color:#ff4f6e">Fehler beim Laden: ${esc(String(err))}</p>`);
});
