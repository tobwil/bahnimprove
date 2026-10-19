// Schriften lokal ausliefern – keine Anfragen an Google (Datenschutz)
import '@fontsource/geist-sans/latin-400.css';
import '@fontsource/geist-sans/latin-500.css';
import '@fontsource/geist-sans/latin-600.css';
import '@fontsource/geist-mono/latin-400.css';
import '@fontsource/geist-mono/latin-500.css';
import '@fontsource/silkscreen/latin-400.css';
import './style.css';
import { dailyReport, type DailyReport, type Objective } from './sim/analysis.ts';
import { defaultPolicy, simulate } from './sim/engine.ts';
import { ArrivalIndex, activeIncidents as simIncidents, hotspotsAt, hourlyPunctuality, trainAt, trainsAt, type LiveHotspot, type TrainState } from './sim/live.ts';
import { buildDayModel, type DayModel } from './sim/model.ts';
import { observedResult, type ObservedStats } from './sim/real.ts';
import { RegionalLayer } from './regional/layer.ts';
import { tilesAround, tilesInBounds } from './data/regional.ts';
import type { RealtimeDay } from './realtime/types.ts';
import { causeText, fmtDelay, hhmm, shortName, tripLabel } from './sim/text.ts';
import type { SimResult, Timetable } from './sim/types.ts';
import { $, delayColor, esc } from './ui/dom.ts';
import { PixelMap, type LabelMode } from './ui/map.ts';
import type { MapData } from './ui/mapdata.ts';
import { gradeOf, renderReport } from './ui/report.ts';
import { MapGestures } from './ui/gestures.ts';
import { Sheet } from './ui/sheet.ts';
import { Timeline } from './ui/timeline.ts';
import { emptyRow, hotspotRow, incidentRow, journeyCard, journeyVerdict, departureBoard, followCard, searchHitRow, sharePanel, stationRow, trainDetail, trainRow, type Buildup } from './ui/views.ts';
import { aggregateDay, findings, mergeDays, type Insights } from './insights/aggregate.ts';
import { searchJourneys, type JourneyResult } from './sim/journey.ts';
import { matchStations, search } from './sim/search.ts';
import { insightsPage, insightsTeaser } from './ui/insights.ts';
import { aboutPage, imprintPage, privacyPage } from './ui/about.ts';
import { boardIndexOf, cleanName, co2Line, followStatus, isPain, targetIndexOf } from './share/status.ts';

/** Ab dieser Uhrzeit beginnt ein neuer Verkehrstag (Nachtzüge laufen über Mitternacht). */
const DAY_ROLLOVER = 180;
type Tab = 'now' | 'board' | 'trip' | 'search' | 'analysis';
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
  /** Regionalzüge dieses Verkehrstags (Kacheln nach Bedarf) */
  regional: RegionalLayer;
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

/** Fahrplan aus dem nächtlichen Server-Job, sonst der mitgelieferte. */
async function loadTimetable(): Promise<Timetable> {
  try {
    const r = await fetch('api/static/timetable');
    if (r.ok && r.headers.get('content-type')?.includes('json')) return (await r.json()) as Timetable;
  } catch {
    // mitgelieferten nehmen
  }
  return (await fetch('data/timetable.json')).json() as Promise<Timetable>;
}

async function main() {
  const [tt, mapData] = await Promise.all([
    loadTimetable(),
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
      const regional = new RegionalLayer(tt.stations, date, tt.version);
      d = { date, model, result, arrivals: new ArrivalIndex(model, result), bins: hourlyPunctuality(model, result), mode: 'sim', regional };
      const day = d;
      regional.onChange = () => {
        if (state.day === day) renderPanels(netTrains());
      };
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
    tab: 'now' as Tab,
    /** Bahnhof der Abfahrtstafel */
    boardStation: undefined as number | undefined,
    boardMode: 'dep' as 'dep' | 'arr',
    user: undefined as { lat: number; lon: number } | undefined,
    hotspots: [] as LiveHotspot[],
    /** Geteilte Zugfahrt, der diese Ansicht folgt (Empfänger eines Links) */
    follow: undefined as { trip: number; target: number; board: number; name: string } | undefined,
  };
  /** Karte folgt dem Zug, bis jemand selbst schiebt */
  let followCamera = false;

  /** Fern- und geladener Regionalverkehr als ein Netz – für Karte, Suche, Reise und Tafeln. */
  const net = () => state.day.regional.network(state.day.model, state.day.result);
  const netTrains = () => trainsAt(net().model, net().result, state.time);
  /** Regionalkacheln für einen Ort laden (Standort, Bahnhof, Reise). */
  const loadAround = (lat: number, lon: number, radius = 1) => state.day.regional.ensure(tilesAround(lat, lon, radius));

  const canvas = $<HTMLCanvasElement>('map');
  const map = new PixelMap(canvas, $<HTMLCanvasElement>('glow'), mapData, state.day.model);
  const sheet = new Sheet($('sheet'), [$('sheet-grab'), document.querySelector<HTMLElement>('.status')!], $('sheet-body'));
  const timeline = new Timeline(
    $<HTMLCanvasElement>('strip'),
    (minute) => {
      state.time = minute;
      state.live = false;
      syncControls();
    },
    (e, startY) => sheet.takeOver(e, startY, $('strip')),
  );

  /** Simulierte Störungen gibt es nur im Simulationsmodus. */
  const activeIncidents = (m: DayModel, t: number) => (state.day.mode === 'real' ? [] : simIncidents(m, t));

  const layoutMap = () => {
    const hud = document.querySelector<HTMLElement>('.hud')!.getBoundingClientRect();
    const stage = canvas.getBoundingClientRect();
    const peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-peek')) || 236;
    const nav = $('appnav').offsetHeight;
    map.setInsets(hud.bottom - stage.top + 4, sheet.docked ? 0 : peek + nav);
  };
  window.addEventListener('resize', layoutMap);

  // --- Zeitsteuerung ---------------------------------------------------------
  const syncControls = () => {
    const today = serviceNow().date;
    $('day-today').classList.toggle('is-active', state.day.date === today);
    $('day-yesterday').classList.toggle('is-active', state.day.date === addDays(today, -1));
    $('go-live').classList.toggle('is-replay', !state.live);
    $('go-live').setAttribute('aria-label', state.live ? 'Live' : 'Zurück zu Live');
    $('clock-mode').textContent = state.live ? 'Live' : 'Wiedergabe';
    // Wiedergabe deutlich sichtbar auf der Karte, mit eigenem Weg zurück zu Live
    $('replay-bar').hidden = state.live;
    $('replay-date').textContent = state.day.date === serviceNow().date ? 'Heute' : fmtDate(state.day.date);
    $('play').textContent = state.playing ? '❚❚' : '▶';
    $('play').setAttribute('aria-label', state.playing ? 'Pause' : 'Abspielen');
    $('speed').textContent = `${state.speed}×`;
    const tb = $('timeline-btn');
    tb.textContent = state.live ? 'Rückblick' : '● Live';
    tb.classList.toggle('is-live', !state.live);
    tb.setAttribute('aria-label', state.live ? 'Den Tag im Zeitraffer abspielen' : 'Zurück zu Live');
  };

  const switchDay = async (date: string) => {
    state.day = await loadDay(date);
    map.setModel(net().model, net().fvCount);
    closeDetail();
    renderPanels(netTrains());
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
    state.playing = !state.playing;
    syncControls();
  });
  $('speed').addEventListener('click', () => {
    state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length];
    state.playing = true;
    syncControls();
  });
  $('replay-live').addEventListener('click', goLive);
  // Rückblick: den bisherigen Tag ab 5 Uhr im Zeitraffer; im Rückblick führt derselbe Knopf zurück zu Live
  $('timeline-btn').addEventListener('click', () => {
    if (!state.live) return void goLive();
    state.live = false;
    state.time = 5 * 60;
    state.speed = 300;
    state.playing = true;
    syncControls();
  });

  // --- Karte: Zoom, Pan, Auswahl ---------------------------------------------
  const gestures = new MapGestures(canvas, {
    pan: (dx, dy) => {
      followCamera = false;
      const [x0, y0] = map.toMapPixel(0, 0);
      const [x1, y1] = map.toMapPixel(dx, dy);
      map.pan(x0 - x1, y0 - y1);
    },
    zoom: (factor, x, y) => {
      const [mx, my] = map.toMapPixel(x, y);
      map.zoomAt(factor, mx, my);
    },
    tap: (x, y) => {
      const [mx, my] = map.toMapPixel(x, y);
      const hit = map.hitTest(mx, my);
      if (hit?.type === 'train') selectTrain(hit.id, false);
      else if (hit?.type === 'station') selectStation(hit.id, true);
      else backToMap();
    },
    hover: (x, y) => hover(x, y),
  });
  canvas.addEventListener('pointerleave', () => ($('tooltip').hidden = true));
  if (import.meta.env.DEV) Object.assign(window, { __map: map });
  $('zoom-in').addEventListener('click', () => map.zoomAt(1.5, map.w / 2, map.h / 2));
  $('zoom-out').addEventListener('click', () => map.zoomAt(1 / 1.5, map.w / 2, map.h / 2));
  $('zoom-reset').addEventListener('click', () => map.reset());

  // --- Ebenen: Beschriftung, Zugfilter, Legende -------------------------------------
  type TrainKind = 'fv' | 'rv' | 's' | 'late';
  const PREFS_KEY = 'bahnimprove.map';
  const prefs = { labels: 'few' as LabelMode, show: { fv: true, rv: true, s: true, late: false } as Record<TrainKind, boolean> };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    if (saved && ['few', 'many', 'off'].includes(saved.labels)) prefs.labels = saved.labels;
    if (saved?.show) for (const k of Object.keys(prefs.show) as TrainKind[]) if (typeof saved.show[k] === 'boolean') prefs.show[k] = saved.show[k];
  } catch {
    // Standard behalten
  }
  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // nicht speicherbar, gilt dann nur für diesen Besuch
    }
  };
  const layersEl = $('layers');
  const syncLayers = () => {
    map.setLabelMode(prefs.labels);
    layersEl.querySelectorAll<HTMLElement>('[data-label]').forEach((b) => b.classList.toggle('is-active', b.dataset.label === prefs.labels));
    layersEl.querySelectorAll<HTMLElement>('[data-kind]').forEach((b) => {
      const on = prefs.show[b.dataset.kind as TrainKind];
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    // Ein Filter ist aktiv: der Knopf leuchtet, damit niemand Züge vermisst
    const filtered = prefs.labels !== 'few' || !prefs.show.fv || !prefs.show.rv || !prefs.show.s || prefs.show.late;
    $('layers-btn').classList.toggle('is-active', filtered);
  };
  syncLayers();
  $('layers-btn').addEventListener('click', () => {
    layersEl.hidden = !layersEl.hidden;
    $('layers-btn').setAttribute('aria-expanded', String(!layersEl.hidden));
  });
  layersEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-label], [data-kind]');
    if (!b) return;
    if (b.dataset.label) prefs.labels = b.dataset.label as LabelMode;
    else {
      const k = b.dataset.kind as TrainKind;
      prefs.show[k] = !prefs.show[k];
    }
    savePrefs();
    syncLayers();
  });
  canvas.addEventListener('pointerdown', () => {
    if (!layersEl.hidden) {
      layersEl.hidden = true;
      $('layers-btn').setAttribute('aria-expanded', 'false');
    }
  });
  /** Welche Züge die Karte zeigt (Listen und Kennzahlen bleiben vollständig) */
  const visibleOnMap = (t: TrainState, m: DayModel, fvCount: number) => {
    if (prefs.show.late && !(t.known && t.delay >= 6)) return false;
    if (t.trip < fvCount) return prefs.show.fv;
    return m.trips[t.trip].category === 'S' ? prefs.show.s : prefs.show.rv;
  };

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
    const m = net().model;
    if (hit.type === 'train') {
      const s = trainAt(m, net().result, hit.id, state.time);
      tooltip.innerHTML = `${esc(tripLabel(m, hit.id))} <b style="color:${s?.known ? delayColor(s.delay) : 'var(--nodata)'}">${s?.known ? fmtDelay(s.delay) : '–'}</b>`;
    } else tooltip.textContent = shortName(m.stations[hit.id].name);
    tooltip.style.left = `${cssX}px`;
    tooltip.style.top = `${cssY}px`;
    tooltip.hidden = false;
  }

  // --- Ansichten im Sheet ----------------------------------------------------
  const views = { now: $('view-now'), board: $('view-board'), search: $('view-search'), trip: $('view-trip'), analysis: $('view-analysis'), detail: $('view-detail') };
  const showView = (v: keyof typeof views) => {
    for (const [k, el] of Object.entries(views)) el.hidden = k !== v;
    $('sheet').classList.toggle('is-detail', v === 'detail');
    // Suche, Reise und Tafel brauchen auf dem Handy den Platz für Eingaben und Ergebnisse
    $('sheet').classList.toggle('is-compact', v === 'search' || v === 'trip' || v === 'board');
    document.querySelector<HTMLElement>('.tabs')!.hidden = v === 'detail';
  };
  const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.tab, .appnav-btn')];
  /** Ansicht wechseln – gemeinsam für die Reiter im Sheet (Desktop) und die App-Navigation (Handy). */
  function selectTab(tab: Tab, fromNav = false) {
    const again = state.tab === tab && views.detail.hidden;
    state.tab = tab;
    for (const t of tabButtons) {
      const on = t.dataset.tab === tab;
      t.classList.toggle('is-active', on);
      if (t.classList.contains('tab')) t.setAttribute('aria-selected', String(on));
      else if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    }
    closeDetail();
    if (tab === 'now') {
      // "Karte": Sheet einklappen; nochmal tippen zeigt wieder ganz Deutschland
      if (fromNav) {
        if (again && sheet.snap === 'peek') map.reset();
        sheet.set('peek');
      }
      else if (sheet.snap === 'peek') sheet.set('half');
    } else if (tab === 'analysis') sheet.set(fromNav ? 'full' : sheet.snap === 'peek' ? 'half' : sheet.snap);
    else sheet.set('full');
    $('sheet-body').scrollTop = 0;
    if (tab === 'search') {
      renderSearch(true);
      $<HTMLInputElement>('search').focus({ preventScroll: true });
    }
    if (tab === 'board') openBoard(state.boardStation ?? defaultBoardStation());
    if (tab === 'analysis') renderPanels(netTrains());
    if (tab === 'trip' && !$<HTMLInputElement>('trip-time').value) $<HTMLInputElement>('trip-time').value = hhmm(state.time);
  }
  for (const b of tabButtons) b.addEventListener('click', () => selectTab(b.dataset.tab as Tab, b.classList.contains('appnav-btn')));

  function selectTrain(trip: number, fromList: boolean) {
    if (state.selectedTrain !== trip) $('share-box').hidden = true;
    if (state.follow && state.follow.trip !== trip) endFollow();
    state.selectedTrain = trip;
    state.selectedStation = undefined;
    showView('detail');
    renderDetail(true);
    $('sheet-body').scrollTop = 0;
    if (sheet.snap === 'peek') sheet.set('half');
    const m = net().model;
    const s = trainAt(m, net().result, trip, state.time);
    if (fromList || s) {
      const T = m.trips[trip];
      const a = m.stations[T.stops[s?.stop ?? 0]], b = m.stations[T.stops[Math.min((s?.stop ?? 0) + 1, T.stops.length - 1)]];
      const p = s?.progress ?? 0;
      requestAnimationFrame(() => map.ensureVisible(a.lon + (b.lon - a.lon) * p, a.lat + (b.lat - a.lat) * p, sheet.visibleHeight(), fromList ? 2 : 1));
    }
  }

  /** Bahnhof antippen (Karte, Suche, Nähe): Abfahrtstafel dieses Bahnhofs. */
  function selectStation(station: number, fromMap = false) {
    if (state.tab !== 'board') selectTab('board');
    else closeDetail();
    openBoard(station);
    if (fromMap) sheet.set('half');
    const st = state.day.model.stations[station];
    requestAnimationFrame(() => map.ensureVisible(st.lon, st.lat, sheet.visibleHeight()));
  }

  /**
   * Tipp auf eine leere Stelle der Karte: zurück in den Grundzustand (Auswahl weg, Panel
   * eingeklappt, "Karte" aktiv). Der Kartenausschnitt bleibt; ganz Deutschland zeigt ein
   * zweiter Tipp auf "Karte" oder der ◎-Knopf. Wer einem geteilten Zug folgt, bleibt dabei.
   */
  function backToMap() {
    if (state.follow) {
      if (!sheet.docked) sheet.set('peek');
      return;
    }
    if (state.tab !== 'now') selectTab('now', true);
    else {
      closeDetail();
      sheet.set('peek');
    }
  }

  function closeDetail() {
    if (state.follow) endFollow();
    $('share-box').hidden = true;
    state.selectedTrain = undefined;
    state.selectedStation = state.tab === 'board' ? state.boardStation : undefined;
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
    const m = net().model;
    const T = m.trips[id];
    const R = net().result.trips[id];
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
    const { model: m, result: r } = net();
    if (state.selectedTrain !== undefined) {
      const id = state.selectedTrain;
      setHtml('detail', trainDetail(m, r, id, trainAt(m, r, id, state.time), state.time, buildup(id)), force);
      const f = state.follow;
      $('follow-card').hidden = !f || f.trip !== id;
      $('sheet').classList.toggle('is-follow', !!f && f.trip === id);
      if (f && f.trip === id) setHtml('follow-card', followCard(followStatus(m.stations, m.trips[id], r.trips[id], f.target, state.time, f.board), f.name, state.time), force);
    }
  }
  $('detail').addEventListener('click', (e) => {
    const sh = (e.target as HTMLElement).closest<HTMLElement>('[data-share-train]');
    if (sh) return openShare(+sh.dataset.shareTrain!);
    const loc = (e.target as HTMLElement).closest<HTMLElement>('[data-locate-train]');
    if (loc) {
      followCamera = !!state.follow;
      const m = net().model;
      const s = trainAt(m, net().result, +loc.dataset.locateTrain!, state.time);
      if (!s) return;
      const T = m.trips[s.trip];
      const a = m.stations[T.stops[s.stop]], b = m.stations[T.stops[Math.min(s.stop + 1, T.stops.length - 1)]];
      if (sheet.snap === 'full') sheet.set('half');
      requestAnimationFrame(() => map.ensureVisible(a.lon + (b.lon - a.lon) * s.progress, a.lat + (b.lat - a.lat) * s.progress, sheet.visibleHeight(), 3, true));
      return;
    }
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
  $('search-results').addEventListener('click', onRowClick);
  $('nearby').addEventListener('click', onRowClick);
  $<HTMLInputElement>('search').addEventListener('input', () => renderSearch(true));

  // --- Live mitfahren: eigene Fahrt teilen, geteilte Fahrt verfolgen ------------------
  const NAME_KEY = 'bahnimprove.share.name';
  const savedName = () => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  };
  let shareTrip: number | undefined;
  function openShare(trip: number) {
    const box = $('share-box');
    if (!box.hidden && shareTrip === trip) {
      box.hidden = true;
      return;
    }
    shareTrip = trip;
    const { model: m, result: r } = net();
    const s = trainAt(m, r, trip, state.time);
    const T = m.trips[trip];
    const last = T.stops.length - 1;
    const pain = r.trips[trip].known !== false && isPain(Math.max(s?.delay ?? 0, r.trips[trip].arr[last] - T.schedArr[last]));
    box.innerHTML = sharePanel(m, trip, s ? s.stop : 0, savedName(), pain);
    box.hidden = false;
    updateShareCo2();
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  /** CO₂-Zeile im Formular passend zu Ein- und Ausstieg */
  function updateShareCo2() {
    if (shareTrip === undefined) return;
    const { model: m, result: r } = net();
    const st = followStatus(m.stations, m.trips[shareTrip], r.trips[shareTrip], +$<HTMLSelectElement>('share-to').value, state.time, +$<HTMLSelectElement>('share-from').value);
    $('share-co2').textContent = co2Line(st);
  }
  $('share-box').addEventListener('change', updateShareCo2);
  /** Link zur geteilten Fahrt: Tag, Zug (GTFS), Ein- und Ausstieg, Name und bei Regionalzügen die Kachel */
  function shareLink(trip: number, target: number, name: string, board = 0): string {
    const n = net();
    const T = n.model.trips[trip];
    const url = new URL(`/zug/${state.day.date}/${encodeURIComponent(T.gtfsId)}`, location.origin);
    if (board > 0) url.searchParams.set('ab', n.model.stations[T.stops[board]].name);
    url.searchParams.set('bis', n.model.stations[T.stops[target]].name);
    if (name) url.searchParams.set('von', name);
    const tile = trip >= n.fvCount ? state.day.regional.tileOf(trip - n.fvCount) : undefined;
    if (tile) url.searchParams.set('k', tile);
    // Abschluss: hängt ein Messenger Text an den Link, landet er hier statt im Namen
    url.searchParams.set('v', '1');
    return url.toString();
  }
  async function doShare(copyOnly: boolean) {
    if (shareTrip === undefined) return;
    const name = cleanName($<HTMLInputElement>('share-name').value);
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // ohne Speicher eben jedes Mal eintippen
    }
    const target = +$<HTMLSelectElement>('share-to').value;
    const board = +$<HTMLSelectElement>('share-from').value;
    const { model: m, result: r } = net();
    const T = m.trips[shareTrip];
    const url = shareLink(shareTrip, target, name, board);
    const st = followStatus(m.stations, T, r.trips[shareTrip], target, state.time, board);
    const pain = st.known && isPain(st.delay);
    const to = shortName(m.stations[T.stops[target]].name);
    const kg = Math.round(st.co2Kg);
    const text = pain
      ? `Train Pain: Ich sitze im ${T.line} nach ${to}, gerade +${st.delay} Min. Aber: Pain is temporary, CO₂ reduction is forever${kg >= 1 ? ` (rund ${kg} kg weniger als mit dem Auto)` : ''}. Hier siehst du live, wo der Zug ist und wann ich wirklich ankomme:`
      : `Ich sitze im ${T.line} nach ${to}${kg >= 1 ? ` und spare rund ${kg} kg CO₂ gegenüber dem Auto` : ''}. Hier siehst du live, wo der Zug gerade ist und wann ich ankomme:`;
    const result = $('share-result');
    // Kopieren: nur der Link, damit er sich überall einfügen lässt (auch in die Adresszeile)
    if (copyOnly) {
      try {
        await navigator.clipboard.writeText(url);
        result.textContent = 'Link kopiert.';
      } catch {
        result.innerHTML = `Diesen Link teilen: <input class="share-url" readonly value="${esc(url)}" onclick="this.select()" />`;
      }
      return;
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: pain ? 'Share my Train Pain' : 'Share my Train', text, url });
        result.textContent = 'Geteilt. Der Link zeigt die Fahrt bis zur Ankunft live.';
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    // Kein Teilen-Menü (z. B. Desktop-Browser): Nachricht mit Link kopieren, WhatsApp anbieten
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      result.innerHTML = `Nachricht mit Link kopiert, jetzt im Chat einfügen. <a href="https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}" target="_blank" rel="noopener">Per WhatsApp senden</a>`;
    } catch {
      result.innerHTML = `Diesen Link teilen: <input class="share-url" readonly value="${esc(url)}" onclick="this.select()" />`;
    }
  }
  $('share-box').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#share-go')) void doShare(false);
    else if (t.closest('#share-copy')) void doShare(true);
  });

  function endFollow() {
    state.follow = undefined;
    followCamera = false;
    $('follow-card').hidden = true;
    $('sheet').classList.remove('is-follow');
    if (location.pathname.startsWith('/zug/')) history.replaceState(null, '', '/');
  }
  /** Geöffneter Link /zug/TAG/ZUG?bis=…&von=…&k=…: Zug suchen, auswählen und ihm folgen */
  async function startFollow(date: string, gtfsId: string, params: URLSearchParams) {
    if (state.day.date !== date) {
      try {
        await switchDay(date);
      } catch {
        return toast('Diese Fahrt liegt außerhalb des aktuellen Fahrplans.');
      }
      if (date !== serviceNow().date) {
        state.live = false;
        state.playing = false;
      }
    }
    const find = () => net().model.trips.findIndex((T) => T.gtfsId === gtfsId);
    let trip = find();
    const tile = params.get('k');
    if (trip < 0 && tile && /^-?\d+_-?\d+$/.test(tile)) {
      await state.day.regional.ensure([tile]);
      trip = find();
    }
    if (trip < 0) return toast('Diese Zugfahrt wurde nicht gefunden. Vielleicht ist der Link von einem anderen Tag?');
    const m = net().model;
    const T = m.trips[trip];
    state.follow = { trip, target: targetIndexOf(m.stations, T, params.get('bis')), board: boardIndexOf(m.stations, T, params.get('ab')), name: cleanName(params.get('von')) };
    // Adresszeile aufräumen (angehängter Text aus Messengern fällt weg)
    history.replaceState(null, '', shareLink(trip, state.follow.target, state.follow.name, state.follow.board));
    if (!state.live) state.time = Math.min(net().result.trips[trip].arr[state.follow.target] + 1, 1440 + DAY_ROLLOVER);
    syncControls();
    followCamera = true;
    selectTrain(trip, true);
    // selectTrain beendet das Folgen nicht für denselben Zug; Karte und Sheet für Empfänger
    if (!sheet.docked) sheet.set('half');
    renderDetail(true);
  }

  // --- Suche -------------------------------------------------------------------
  let searchLoaded: number | undefined;
  function renderSearch(force = false) {
    const { model: m, result: r } = net();
    const q = $<HTMLInputElement>('search').value;
    if (!q.trim()) {
      setHtml('search-results', emptyRow('Linie (ICE 28), Bahnhof (Köln) oder Strecke (Köln München) eingeben.'), force);
      return;
    }
    const res = search(m, r, q, state.time);
    // Regionalzüge des gesuchten Bahnhofs nachladen und dann neu suchen
    const top = res.stations[0];
    if (top !== undefined && searchLoaded !== top) {
      searchLoaded = top;
      const st = m.stations[top];
      void loadAround(st.lat, st.lon, 0).then((changed) => changed && renderSearch(true));
    }
    const html = res.stations.map((st) => stationRow(m, st)).join('') + res.trips.map((h) => searchHitRow(m, r, h)).join('');
    setHtml('search-results', html || emptyRow('Nichts gefunden. Tipp: Bahnhofsname ohne „Hbf“ oder nur die Liniennummer.'), force);
  }

  // --- Standort ----------------------------------------------------------------
  const toastEl = $('toast');
  let toastTimer = 0;
  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), 4500);
  };
  const distKm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => Math.hypot((a.lat - b.lat) * 111.3, (a.lon - b.lon) * 111.3 * Math.cos((a.lat * Math.PI) / 180));
  const nearestStations = (p: { lat: number; lon: number }, n = 3) =>
    state.day.model.stations
      .map((s, i) => ({ i, d: distKm(p, s), w: s.w ?? s.weight }))
      .filter((x) => x.w >= 1 && !/\(Gr\)|Grenze/.test(state.day.model.stations[x.i].name))
      .sort((a, b) => a.d - b.d)
      .slice(0, n);
  function renderNearby() {
    if (!state.user) return;
    $('nearby-block').hidden = false;
    setHtml('nearby', nearestStations(state.user).map((x) => stationRow(state.day.model, x.i, x.d)).join(''), true);
  }
  const locateBtn = $('locate');
  function locate(silent: boolean) {
    if (!('geolocation' in navigator)) {
      if (!silent) toast('Dein Gerät stellt keinen Standort bereit.');
      return;
    }
    locateBtn.classList.add('is-busy');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locateBtn.classList.remove('is-busy');
        locateBtn.classList.add('is-active');
        state.user = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        renderNearby();
        void loadAround(state.user.lat, state.user.lon);
        const near = nearestStations(state.user, 1)[0];
        if (!views.board.hidden && state.boardStation === undefined && near) openBoard(near.i);
        else if (!views.board.hidden) renderBoardChips();
        const from = $<HTMLInputElement>('trip-from');
        if (near && !from.value) {
          from.value = state.day.model.stations[near.i].name;
          tripFrom = near.i;
        }
        if (!silent) {
          map.ensureVisible(state.user.lon, state.user.lat, sheet.visibleHeight(), 3);
          if (near) toast(`Nächster Bahnhof: ${state.day.model.stations[near.i].name} (${near.d < 1 ? `${Math.round(near.d * 1000)} m` : `${near.d.toFixed(1).replace('.', ',')} km`})`);
        }
      },
      (err) => {
        locateBtn.classList.remove('is-busy');
        if (silent) return;
        toast(
          err.code === err.PERMISSION_DENIED
            ? 'Standort ist blockiert. Erlaube ihn in den Browser-Einstellungen für diese Seite und tippe erneut auf den Knopf.'
            : 'Standort gerade nicht verfügbar. Versuch es draußen oder mit WLAN noch einmal.',
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }
  locateBtn.addEventListener('click', () => locate(false));
  // Wer schon einmal zugestimmt hat, wird ohne erneute Nachfrage gefunden.
  navigator.permissions
    ?.query({ name: 'geolocation' as PermissionName })
    .then((p) => {
      if (p.state === 'granted') locate(true);
    })
    .catch(() => {});

  // --- Abfahrtstafel ------------------------------------------------------------
  const RECENT_KEY = 'bahnimprove.board.recent';
  /** Zuletzt gewählte Bahnhöfe (nur auf diesem Gerät, als Namen – die stabil über Fahrplanversionen sind) */
  const loadRecent = (): string[] => {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 4) : [];
    } catch {
      return [];
    }
  };
  const saveRecent = (name: string) => {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([name, ...loadRecent().filter((x) => x !== name)].slice(0, 4)));
    } catch {
      // ohne Speicher eben ohne Verlauf
    }
  };
  const stationByName = (name: string) => {
    const i = state.day.model.stations.findIndex((s) => s.name === name);
    return i < 0 ? undefined : i;
  };
  const BIG_STATIONS = ['Hamburg Hbf', 'Berlin Hbf', 'Köln Hbf', 'Frankfurt (Main) Hbf', 'München Hbf'];
  /** Zuletzt benutzter Bahnhof, sonst der nächste zum Standort */
  const defaultBoardStation = () => {
    const recent = loadRecent().map(stationByName).find((i) => i !== undefined);
    if (recent !== undefined) return recent;
    return state.user ? nearestStations(state.user, 1)[0]?.i : undefined;
  };
  let boardLoading = false;
  function openBoard(station: number | undefined, remember = false) {
    state.boardStation = station;
    if (!views.detail.hidden) showView('board');
    state.selectedStation = station;
    const input = $<HTMLInputElement>('board-input');
    input.value = '';
    input.placeholder = station === undefined ? 'Bahnhof wählen …' : `${state.day.model.stations[station].name} · anderer Bahnhof …`;
    $('board-suggest').hidden = true;
    if (station !== undefined) {
      if (remember) saveRecent(state.day.model.stations[station].name);
      const st = state.day.model.stations[station];
      boardLoading = true;
      void loadAround(st.lat, st.lon, 0).finally(() => {
        boardLoading = false;
        if (state.boardStation === station) renderBoard(true);
      });
    }
    renderBoardChips();
    renderBoard(true);
  }
  function renderBoardChips() {
    const m = state.day.model;
    const chips: { i: number; meta: string }[] = [];
    const add = (i: number | undefined, meta = '') => i !== undefined && !chips.some((c) => c.i === i) && chips.push({ i, meta });
    if (state.user) for (const x of nearestStations(state.user, 2)) add(x.i, x.d < 1 ? `${Math.round(x.d * 1000)} m` : `${x.d.toFixed(1).replace('.', ',')} km`);
    for (const name of loadRecent()) add(stationByName(name));
    if (chips.length < 3) for (const name of BIG_STATIONS) chips.length < 5 && add(stationByName(name));
    const locate = state.user ? '' : `<button class="chip" data-locate>◎ In meiner Nähe</button>`;
    setHtml(
      'board-chips',
      locate + chips.map((c) => `<button class="chip${c.i === state.boardStation ? ' is-active' : ''}" data-station="${c.i}">${esc(shortName(m.stations[c.i].name))}${c.meta ? `<span class="meta">${c.meta}</span>` : ''}</button>`).join(''),
      true,
    );
  }
  function renderBoard(force = false) {
    const { model: m, result: r } = net();
    if (state.boardStation === undefined) {
      setHtml('board', `<div class="board"><p class="board-empty">Wähle einen Bahnhof oder teile deinen Standort – dann zeigt die Tafel die nächsten Abfahrten mit erwarteter Verspätung.</p></div>`, force);
      return;
    }
    const typical = (station: string, line: string) => insights?.typical?.[`${station}|${line}`];
    setHtml('board', departureBoard(m, r, state.boardStation, state.time, { mode: state.boardMode, live: state.day.mode === 'real', typical, loading: boardLoading }), force);
  }
  const boardInput = $<HTMLInputElement>('board-input');
  const boardSuggest = $('board-suggest');
  boardInput.addEventListener('input', () => {
    const m = state.day.model;
    const list = boardInput.value.trim() ? matchStations(m, boardInput.value.split(' '), 6) : [];
    boardSuggest.innerHTML = list.map((i) => `<li data-station="${i}"><span>${esc(m.stations[i].name)}</span></li>`).join('');
    boardSuggest.hidden = !list.length;
  });
  boardInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = boardSuggest.querySelector<HTMLElement>('[data-station]');
    if (first) {
      openBoard(+first.dataset.station!, true);
      boardInput.blur();
    }
  });
  boardSuggest.addEventListener('pointerdown', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-station]');
    if (!li) return;
    e.preventDefault();
    openBoard(+li.dataset.station!, true);
    boardInput.blur();
  });
  $('board-chips').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-station], [data-locate]');
    if (!b) return;
    if (b.dataset.locate !== undefined) locate(false);
    else openBoard(+b.dataset.station!, true);
  });
  for (const mode of ['dep', 'arr'] as const) {
    $(`board-${mode}`).addEventListener('click', () => {
      state.boardMode = mode;
      $('board-dep').classList.toggle('is-active', mode === 'dep');
      $('board-arr').classList.toggle('is-active', mode === 'arr');
      renderBoard(true);
    });
  }
  $('board').addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-trip]');
    if (row) selectTrain(+row.dataset.trip!, true);
  });

  // --- Verbindungssuche --------------------------------------------------------
  let tripFrom: number | undefined;
  let tripTo: number | undefined;
  let lastJourneys: JourneyResult | null = null;
  let tripDay: Day | null = null;
  const suggestEl = $('trip-suggest');
  let suggestFor: 'from' | 'to' | null = null;
  const showSuggest = (which: 'from' | 'to') => {
    const input = $<HTMLInputElement>(which === 'from' ? 'trip-from' : 'trip-to');
    const m = state.day.model;
    const list = matchStations(m, input.value.split(' '), 6);
    suggestFor = which;
    const near = state.user && which === 'from' && !input.value.trim() ? nearestStations(state.user, 3) : [];
    const items = near.length ? near.map((x) => ({ i: x.i, meta: `${x.d.toFixed(1).replace('.', ',')} km` })) : list.map((i) => ({ i, meta: '' }));
    suggestEl.innerHTML = items.map((x) => `<li data-station="${x.i}"><span>${esc(m.stations[x.i].name)}</span><span class="meta">${x.meta}</span></li>`).join('');
    suggestEl.hidden = !items.length;
  };
  for (const which of ['from', 'to'] as const) {
    const input = $<HTMLInputElement>(which === 'from' ? 'trip-from' : 'trip-to');
    input.addEventListener('input', () => {
      if (which === 'from') tripFrom = undefined;
      else tripTo = undefined;
      showSuggest(which);
    });
    input.addEventListener('focus', () => {
      showSuggest(which);
      if (sheet.snap !== 'full') sheet.set('full');
    });
  }
  suggestEl.addEventListener('pointerdown', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-station]');
    if (!li || !suggestFor) return;
    e.preventDefault();
    const i = +li.dataset.station!;
    const input = $<HTMLInputElement>(suggestFor === 'from' ? 'trip-from' : 'trip-to');
    input.value = state.day.model.stations[i].name;
    if (suggestFor === 'from') {
      tripFrom = i;
      $<HTMLInputElement>('trip-to').focus();
    } else {
      tripTo = i;
      suggestEl.hidden = true;
      input.blur();
      runJourney();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement).closest('.trip-form')) suggestEl.hidden = true;
    if (!(e.target as HTMLElement).closest('.board-pick')) boardSuggest.hidden = true;
  });
  $('trip-swap').addEventListener('click', () => {
    const a = $<HTMLInputElement>('trip-from'), b = $<HTMLInputElement>('trip-to');
    [a.value, b.value] = [b.value, a.value];
    [tripFrom, tripTo] = [tripTo, tripFrom];
    if (tripFrom !== undefined && tripTo !== undefined) runJourney();
  });
  $('trip-form').addEventListener('submit', (e) => {
    e.preventDefault();
    suggestEl.hidden = true;
    runJourney();
  });
  const resolveStation = (value: string) => matchStations(state.day.model, value.split(' '), 1)[0];
  async function runJourney() {
    const m = state.day.model;
    tripFrom ??= resolveStation($<HTMLInputElement>('trip-from').value);
    tripTo ??= resolveStation($<HTMLInputElement>('trip-to').value);
    if (tripFrom === undefined || tripTo === undefined) {
      $('trip-results').innerHTML = `<p class="fine">Bitte Start und Ziel aus der Liste wählen.</p>`;
      return;
    }
    if (tripFrom === tripTo) {
      $('trip-results').innerHTML = `<p class="fine">Start und Ziel sind derselbe Bahnhof.</p>`;
      return;
    }
    const tv = $<HTMLInputElement>('trip-time').value;
    let after = state.time;
    if (tv) {
      const [h, mm] = tv.split(':').map(Number);
      after = h * 60 + mm;
      if (after < DAY_ROLLOVER && state.time > DAY_ROLLOVER) after += 1440;
    }
    $('trip-results').innerHTML = `<p class="fine">Suche Verbindungen, lade Regionalzüge rund um Start und Ziel …</p>`;
    // Eine Uhrzeit, die heute schon vorbei ist, meint morgen
    let day = state.day;
    let now = state.time;
    if (tv && after < state.time - 30) {
      day = await loadDay(addDays(state.day.date, 1));
      now = -Infinity;
    }
    tripDay = day;
    const a = m.stations[tripFrom], b = m.stations[tripTo];
    await Promise.all([a, b].map((st) => day.regional.ensure(tilesAround(st.lat, st.lon, 1))));
    const n = day.regional.network(day.model, day.result);
    lastJourneys = searchJourneys(n.model, n.result, tripFrom, tripTo, after - 5, now);
    renderJourneys();
  }
  function renderJourneys() {
    if (!lastJourneys) return;
    const day = tripDay ?? state.day;
    const m = day.regional.network(day.model, day.result).model;
    const res = lastJourneys;
    const other = day !== state.day ? `<p class="fine">Verbindungen für ${fmtDate(day.date)} laut Fahrplan.</p>` : '';
    $('trip-results').innerHTML = res.journeys.length
      ? `${other}${journeyVerdict(m, res)}<div class="journeys">${res.journeys.map((j, i) => journeyCard(m, j, i === res.recommended, state.time, transferHistory)).join('')}</div>
         <p class="fine">Fern- und Regionalverkehr (ohne Busse und Trams), bis zu zwei Umstiege. Die Wahrscheinlichkeit berücksichtigt die aktuelle Verspätung, wie lange der Zubringer noch unterwegs ist, und eine Mindestumsteigezeit von 4 bis 6 Minuten. Dass ein Anschlusszug wartet, ist nicht eingerechnet.</p>`
      : `<p class="fine">Keine Zugverbindung mit höchstens zwei Umstiegen in den nächsten vier Stunden gefunden. Lange Strecken nur mit Regionalzügen fehlen noch: Unterwegs werden nur Fernzüge berücksichtigt.</p>`;
  }
  $('trip-results').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-trip]');
    if (b && (!tripDay || tripDay === state.day)) selectTrain(+b.dataset.trip!, true);
  });

  // --- Lessons learned -------------------------------------------------------------
  const overlay = $('report');
  let insights: Insights | null = null;
  const transferHistory = (station: string, from: string, to: string) => insights?.transferHistory?.[`${station}|${from}|${to}`];
  async function loadInsights() {
    try {
      const r = await fetch('api/insights', { cache: 'no-cache' });
      if (r.ok && r.headers.get('content-type')?.includes('json')) {
        insights = (await r.json()) as Insights;
        return;
      }
    } catch {
      // lokal berechnen
    }
    // Ohne Server (Vorschau, lokal): vorläufig aus dem geladenen Tag
    const d = state.day;
    insights = d.mode === 'real' ? findings(mergeDays([aggregateDay(d.model, d.result)])) : null;
  }
  void loadInsights().then(() => renderPanels(netTrains()));
  setInterval(() => void loadInsights(), 30 * 60_000);
  /** Steckbrief einer Linie aus dem Fahrplan des Tages und den Befunden, die sie betreffen */
  const lineInfo = (line: string, ins: Insights) => {
    const m = state.day.model;
    const trips = m.trips.filter((T) => T.line === line);
    const lineStat = ins.lines.find((l) => l.line === line);
    if (!trips.length) return `<p class="fine">Heute fährt ${esc(line)} laut Fahrplan nicht.</p>`;
    // Häufigster Laufweg (Richtung egal) als Strecke
    const routes = new Map<string, { n: number; stops: number[] }>();
    for (const T of trips) {
      const a = T.stops[0], b = T.stops[T.stops.length - 1];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const r = routes.get(key) ?? { n: 0, stops: T.stops };
      r.n++;
      if (T.stops.length > r.stops.length) r.stops = a < b ? T.stops : [...T.stops].reverse();
      routes.set(key, r);
    }
    const main = [...routes.values()].sort((x, y) => y.n - x.n)[0].stops;
    const via = main.slice(1, -1).filter((s) => m.stations[s].weight > 200).map((s) => shortName(m.stations[s].name));
    const operators = [...new Set(trips.map((T) => T.operator).filter(Boolean))];
    const sn = (s: number) => shortName(m.stations[s].name);
    const running = netTrains().filter((t) => m.trips[t.trip]?.line === line && t.trip < net().fvCount);
    const late = running.filter((t) => t.known && t.delay >= 6);
    const related = ins.findings.filter((f) => f.evidence.includes(`${line})`) || f.evidence.includes(`${line},`) || f.evidence.includes(`${line} `)).slice(0, 3);
    return `
      <p class="line-route"><b>${esc(sn(main[0]))} ⇄ ${esc(sn(main[main.length - 1]))}</b>${via.length ? `<br><span class="sub">über ${esc(via.slice(0, 6).join(' · '))}</span>` : ''}</p>
      <dl class="line-facts">
        <div><dt>Betreiber</dt><dd>${esc(operators.join(', ') || '–')}</dd></div>
        <div><dt>Fahrten heute</dt><dd>${trips.length}</dd></div>
        <div><dt>Pünktlich</dt><dd>${lineStat ? `${Math.round(lineStat.punctuality * 100)} % von ${lineStat.arrivals} Ankünften` : '–'}</dd></div>
        <div><dt>Gerade unterwegs</dt><dd>${running.length ? `${running.length}${late.length ? `, davon ${late.length} verspätet` : ''}` : 'keiner'}</dd></div>
      </dl>
      ${related.length ? `<p class="eyebrow" style="margin:10px 0 4px">Wo diese Linie Zeit verliert</p><ul class="line-related">${related.map((f) => `<li><b>${esc(f.place)}</b> ${esc(f.evidence)}</li>`).join('')}</ul>` : ''}
      <button class="ghost-btn" data-show-line="${esc(line)}">Züge von ${esc(line)} auf der Karte</button>`;
  };
  const openInsights = () => {
    $('report-eyebrow').textContent = 'Lessons learned für die DB';
    $('report-title').textContent = 'Was die DB lernen kann';
    overlay.hidden = false;
    overlay.style.setProperty('--c', 'var(--lamp)');
    $('report-share').hidden = false;
    $('report-body').innerHTML = insights ? insightsPage(insights, lineInfo) : '<div class="loading">Lade Erkenntnisse …<div class="loading-bar"></div></div>';
  };
  $('open-insights').addEventListener('click', openInsights);
  const openAbout = () => {
    $('report-eyebrow').textContent = 'Share my Train';
    $('report-title').textContent = 'Über, Daten & Datenschutz';
    $('report-share').hidden = true;
    overlay.hidden = false;
    overlay.style.setProperty('--c', 'var(--accent)');
    $('report-body').innerHTML = aboutPage();
    $('report-body').parentElement!.scrollTop = 0;
  };
  const openPrivacy = () => {
    $('report-eyebrow').textContent = 'Share my Train';
    $('report-title').textContent = 'Datenschutzerklärung';
    $('report-share').hidden = true;
    overlay.hidden = false;
    overlay.style.setProperty('--c', 'var(--accent)');
    $('report-body').innerHTML = privacyPage();
    $('report-body').parentElement!.scrollTop = 0;
  };
  const openImprint = () => {
    $('report-eyebrow').textContent = 'Share my Train';
    $('report-title').textContent = 'Impressum';
    $('report-share').hidden = true;
    overlay.hidden = false;
    overlay.style.setProperty('--c', 'var(--accent)');
    $('report-body').innerHTML = imprintPage();
    $('report-body').parentElement!.scrollTop = 0;
  };
  $('open-about').addEventListener('click', openAbout);
  // Rechtliche Links (Karte, Fußzeile, Über-Seite) öffnen die Seiten in der App
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-legal]');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.legal === 'privacy') openPrivacy();
    else if (a.dataset.legal === 'imprint') openImprint();
    else openAbout();
  });
  $('report-share').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.pathname = url.pathname.replace(/\/(bericht\/?)?$/, '/bericht');
    url.hash = '';
    const data = { title: 'Was die DB lernen kann – Share my Train', text: 'Lessons learned für die Bahn aus echten Ist-Daten', url: url.toString() };
    try {
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(data.url);
        toast('Link kopiert');
      }
    } catch {
      // Teilen abgebrochen
    }
  });

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

  function renderPanels(all: TrainState[]) {
    const d = state.day;
    const n = net();
    const m = n.model;
    const real = d.mode === 'real';
    const sofar = d.arrivals.until(state.time);
    // Kennzahlen gelten für den Fernverkehr (bundesweit vollständig); Listen zeigen alle geladenen Züge
    const trains = all.filter((t) => t.trip < n.fvCount);
    const known = trains.filter((t) => t.known);
    const allKnown = all.filter((t) => t.known);

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
    state.hotspots = hotspotsAt(m, n.result, state.time);
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
    const top = [...allKnown].sort((a, b) => b.delay - a.delay).slice(0, 6);
    setHtml('worst', top.length ? top.map((t) => trainRow(m, t)).join('') : emptyRow('Gerade kein Zug unterwegs.'));

    if (!views.search.hidden) renderSearch();
    if (!views.board.hidden) renderBoard();
    if (!views.trip.hidden && lastJourneys) renderJourneys();
    if (state.user) renderNearby();

    // Analyse
    if (!views.analysis.hidden) {
      const g = gradeOf(sofar.punctuality);
      const teaser = $('report-teaser');
      teaser.style.setProperty('--c', g.color);
      setHtml('report-teaser', `<span class="teaser-grade">${sofar.arrivals ? g.grade : '–'}</span><span><span class="eyebrow">Stand ${hhmm(state.time)} · ${fmtDate(d.date)}</span><br>${sofar.arrivals ? esc(g.text) : 'Noch keine Ankünfte.'}</span>`);
      setHtml('insights-teaser', insightsTeaser(insights));
    }

    if (!views.detail.hidden) renderDetail();
    timeline.setData(d.bins, d.date === serviceNow().date ? serviceNow().minutes : Infinity);
  }

  // --- Tagesbericht ----------------------------------------------------------
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
    $('report-share').hidden = true;
    $('report-eyebrow').textContent = 'Tagesabschluss';
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
    const sl = (e.target as HTMLElement).closest<HTMLElement>('[data-show-line]');
    if (sl) {
      overlay.hidden = true;
      $<HTMLInputElement>('search').value = sl.dataset.showLine!;
      selectTab('search');
      return;
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
    if (d.date !== serviceNow().date) return;
    void d.regional.refresh();
    if (await refreshRealtime(d)) renderPanels(netTrains());
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
    gestures.step();
    const n = net();
    // Karte immer mit dem aktuellen Netz zeichnen (Kacheln laden im Hintergrund nach)
    if (map.model !== n.model) map.setModel(n.model, n.fvCount);
    const trains = trainsAt(n.model, n.result, state.time);
    if (now - lastPanel > 500) {
      lastPanel = now;
      // Regionalzüge im sichtbaren Ausschnitt nachladen, sobald nah genug herangezoomt
      if (map.zoom >= 2.2 && !gestures.dragging) {
        const [lon0, lat0] = map.unproject(0, 0), [lon1, lat1] = map.unproject(map.w, map.h);
        void d.regional.ensure(tilesInBounds({ minLat: Math.min(lat0, lat1), maxLat: Math.max(lat0, lat1), minLon: lon0, maxLon: lon1 }, 24));
      }
      renderPanels(trains);
      if (state.follow && followCamera) {
        const s = trains.find((t) => t.trip === state.follow!.trip);
        if (s) {
          const T = n.model.trips[s.trip];
          const a = n.model.stations[T.stops[s.stop]], b = n.model.stations[T.stops[Math.min(s.stop + 1, T.stops.length - 1)]];
          map.ensureVisible(a.lon + (b.lon - a.lon) * s.progress, a.lat + (b.lat - a.lat) * s.progress, sheet.visibleHeight(), 2.5);
        }
      }
    }
    const maxHot = Math.max(30, ...state.hotspots.map((h) => h.minutes));
    map.draw({
      trains: trains.filter((t) => visibleOnMap(t, n.model, n.fvCount)),
      incidents: activeIncidents(d.model, state.time),
      fvCount: n.fvCount,
      hotspots: state.hotspots.slice(0, 8).map((h) => ({ station: h.station, intensity: h.minutes / maxHot })),
      selected: { train: state.selectedTrain, station: state.selectedStation },
      minute: state.time,
      now,
      user: state.user,
    });
    timeline.draw(state.time);
    $('clock').textContent = hhmm(state.time);
    requestAnimationFrame(loop);
  };

  // Teilbarer Wochenbericht: /bericht (oder #bericht) öffnet direkt die Lessons learned
  const isReportLink = /\/bericht\/?$/.test(location.pathname) || location.hash === '#bericht';
  if (isReportLink) {
    openInsights();
    void loadInsights().then(() => !overlay.hidden && insights && ($('report-body').innerHTML = insightsPage(insights, lineInfo)));
  } else if (location.hash === '#abfahrten') selectTab('board');
  else if (/\/datenschutz\/?$/.test(location.pathname) || location.hash === '#datenschutz') openPrivacy();
  else if (/\/impressum\/?$/.test(location.pathname) || location.hash === '#impressum') openImprint();
  // Zug-Link direkt oder über den Notfall-Weg /?folge=/zug/… der Vorschau-Funktion
  const folge = new URLSearchParams(location.search).get('folge');
  const followTarget = folge?.startsWith('/zug/') ? new URL(folge, location.origin) : location;
  const followLink = followTarget.pathname.match(/^\/zug\/(\d{8})\/([^/]+)\/?$/);
  // Angehängter Text aus Messengern ("/zug/…/913549 Ich sitze …") gehört nicht zur Zug-ID
  if (followLink) void startFollow(followLink[1], decodeURIComponent(followLink[2]).split(/\s/)[0], new URLSearchParams(followTarget.search));
  watchHostBadge(layoutMap);
  layoutMap();
  syncControls();
  renderPanels(netTrains());
  requestAnimationFrame(loop);
}

/**
 * Der Hoster blendet im Gratis-Tarif unten rechts ein Badge ein, das sich nicht ausblenden lässt.
 * Statt es zu verdecken, bekommt es Platz: --host-badge schiebt die App-Navigation darüber.
 */
function watchHostBadge(onChange: () => void) {
  let current = -1;
  const measure = () => {
    const f = document.getElementById('nl-badge-frame');
    const h = f ? Math.round(f.getBoundingClientRect().height) : 0;
    // Aufgeklappt (Popover) ist das Badge nur kurz größer – dann die bisherige Höhe behalten
    if (h > 100 || h === current) return;
    current = h;
    document.documentElement.style.setProperty('--host-badge', `${h}px`);
    onChange();
  };
  const ro = new ResizeObserver(measure);
  new MutationObserver(() => {
    const f = document.getElementById('nl-badge-frame');
    if (f) ro.observe(f);
    measure();
  }).observe(document.body, { childList: true });
  measure();
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin', `<p style="position:fixed;z-index:99;padding:16px;color:#ff4f6e">Fehler beim Laden: ${esc(String(err))}</p>`);
});
