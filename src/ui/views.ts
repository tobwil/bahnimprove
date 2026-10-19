import type { Journey, JourneyResult } from '../sim/journey.ts';
import type { LiveHotspot, TrainState } from '../sim/live.ts';
import type { TripHit } from '../sim/search.ts';
import type { DayModel } from '../sim/model.ts';
import { INCIDENT_LABEL, fmtDelay, hhmm, incidentPlace, shortName } from '../sim/text.ts';
import type { Incident, SimResult } from '../sim/types.ts';
import { OBS_ARR, OBS_DEP } from '../sim/real.ts';
import { co2Line, isPain, type FollowStatus } from '../share/status.ts';
import { delayColor, esc } from './dom.ts';

export const lineBadge = (m: DayModel, trip: number) => {
  const T = m.trips[trip];
  return `<span class="line-badge" data-cat="${esc(T.category)}">${esc(T.line)}</span>`;
};

const endpoints = (m: DayModel, trip: number) => {
  const T = m.trips[trip];
  return `${shortName(m.stations[T.stops[0]].name)} → ${shortName(m.stations[T.stops[T.stops.length - 1]].name)}`;
};

/** "zwischen Fulda und Kassel" bzw. "in Fulda" */
export function whereText(m: DayModel, s: TrainState): string {
  const T = m.trips[s.trip];
  const a = shortName(m.stations[T.stops[s.stop]].name);
  if (s.atStation || s.stop >= T.stops.length - 1) return `in ${a}`;
  return `zwischen ${a} und ${shortName(m.stations[T.stops[s.stop + 1]].name)}`;
}

export function trainRow(m: DayModel, s: TrainState): string {
  const c = s.known ? delayColor(s.delay) : 'var(--nodata)';
  return `<li class="row" data-trip="${s.trip}">
    ${lineBadge(m, s.trip)}
    <span class="row-main"><span class="row-title">${esc(endpoints(m, s.trip))}</span><span class="row-sub">${esc(whereText(m, s))}</span></span>
    <span class="delay" style="--c:${c}">${s.known ? fmtDelay(s.delay) : '–'}</span>
  </li>`;
}

export function hotspotRow(m: DayModel, h: LiveHotspot): string {
  const st = m.stations[h.station];
  const perTrain = h.minutes / Math.max(1, h.trains);
  return `<li class="row" data-lon="${st.lon}" data-lat="${st.lat}" data-station="${h.station}">
    <span class="pin" style="--c:${delayColor(perTrain * 2.5)}">+${Math.round(h.minutes)}</span>
    <span class="row-main"><span class="row-title">${esc(shortName(st.name))}</span><span class="row-sub">${h.trains} ${h.trains === 1 ? 'Zug hat' : 'Züge haben'} hier Zeit verloren</span></span>
    <span></span>
  </li>`;
}

export function incidentRow(m: DayModel, i: Incident): string {
  const c = i.blocking ? 'var(--bad)' : i.kind === 'bau' ? 'var(--late)' : 'var(--warn)';
  return `<li class="row" data-lon="${i.lon}" data-lat="${i.lat}">
    <span class="pin" style="--c:${c}">${i.blocking ? '■' : i.kind === 'bau' ? '▲' : '!'}</span>
    <span class="row-main"><span class="row-title">${INCIDENT_LABEL[i.kind]}</span><span class="row-sub">${esc(incidentPlace(m, i))}${i.kind === 'bau' ? ' · ganztägig' : ` · bis ${hhmm(i.end)}`}</span></span>
    <span></span>
  </li>`;
}

export const emptyRow = (text: string) => `<li class="row is-empty">${esc(text)}</li>`;

/** Verspätung je Halt als Pixel-Balken; vergangene Halte kräftig, Prognosen blass. */
function profileSvg(m: DayModel, r: SimResult, trip: number, now: number): string {
  const T = m.trips[trip];
  const R = r.trips[trip];
  const n = T.stops.length;
  const delays = T.stops.map((_, i) => Math.max(0, i === 0 ? R.dep[0] - T.schedDep[0] : R.arr[i] - T.schedArr[i]));
  const max = Math.max(10, ...delays);
  const bw = 100 / n;
  const bars = delays
    .map((d, i) => {
      const h = Math.max(1.2, (d / max) * 34);
      const past = (i === 0 ? R.dep[0] : R.arr[i]) <= now;
      return `<rect x="${(i * bw + bw * 0.12).toFixed(2)}" y="${(36 - h).toFixed(2)}" width="${(bw * 0.76).toFixed(2)}" height="${h.toFixed(2)}" fill="${delayColor(d)}" opacity="${past ? 1 : 0.35}"/>`;
    })
    .join('');
  const guide = (6 / max) * 34;
  return `<svg viewBox="0 0 100 40" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Verspätung je Halt, höchstens ${Math.round(max)} Minuten">
    <rect x="0" y="${(36 - guide).toFixed(2)}" width="100" height="0.4" fill="#5d6789"/>
    ${bars}
    <rect x="0" y="36" width="100" height="0.6" fill="#2a3557"/>
  </svg>
  <div class="strip-hours"><span>${esc(shortName(m.stations[T.stops[0]].name))}</span><span>max. +${Math.round(Math.max(...delays))} Min</span><span>${esc(shortName(m.stations[T.stops[n - 1]].name))}</span></div>`;
}

export interface Buildup {
  at: number;
  minutes: number;
  text: string;
}

export function trainDetail(m: DayModel, r: SimResult, trip: number, s: TrainState | null, now: number, buildup: Buildup[]): string {
  const T = m.trips[trip];
  const R = r.trips[trip];
  const n = T.stops.length;
  const unknown = R.known === false;
  const finalDelay = R.arr[n - 1] - T.schedArr[n - 1];
  const delayNow = s ? s.delay : now < R.dep[0] ? Math.max(0, R.dep[0] - T.schedDep[0]) : Math.max(0, finalDelay);
  const c = unknown ? 'var(--nodata)' : delayColor(delayNow);
  const status = R.canceled
    ? 'Fällt aus'
    : unknown
      ? 'Keine Echtzeitdaten, Position nach Fahrplan'
      : s
        ? `${whereText(m, s)} · Ankunft ${shortName(m.stations[T.stops[n - 1]].name)} ${hhmm(R.arr[n - 1])}`
        : now < R.dep[0]
          ? `Abfahrt ${hhmm(R.dep[0])} in ${shortName(m.stations[T.stops[0]].name)}`
          : `Angekommen ${hhmm(R.arr[n - 1])} in ${shortName(m.stations[T.stops[n - 1]].name)}`;
  const stops = T.stops
    .map((st, i) => {
      const sched = i === 0 ? T.schedDep[i] : T.schedArr[i];
      const act = i === 0 ? R.dep[i] : R.arr[i];
      const d = act - sched;
      const past = act <= now;
      const isNow = s && s.stop === i;
      const time = unknown || d < 0.5 ? hhmm(sched) : `<s>${hhmm(sched)}</s><span style="color:${delayColor(d)}">${hhmm(act)}</span>`;
      return `<li class="${past ? 'is-past' : ''} ${isNow ? 'is-now' : ''}"><span class="node"></span><span class="name">${esc(shortName(m.stations[st].name))}</span><span class="times">${time}</span></li>`;
    })
    .join('');
  const shown = buildup.filter((b) => b.at <= now + 0.01);
  return `
    <div class="detail-head">
      <div class="detail-title">${lineBadge(m, trip)}<span class="detail-route">${esc(endpoints(m, trip))}</span></div>
      <div class="big-delay" style="--c:${c}">${R.canceled ? 'Ausfall' : unknown ? '–' : `${fmtDelay(delayNow)}<small>Min</small>`}</div>
      <div class="detail-meta">${esc(status)} · ${esc(T.operator)}</div>
      <div class="detail-actions">
        ${s ? `<button class="ghost-btn" data-locate-train="${trip}">◎ Auf der Karte zeigen</button>` : ''}
        ${!R.canceled && now < R.arr[n - 1] ? `<button class="ghost-btn ghost-btn--accent" data-share-train="${trip}">${shareBrand(!unknown && isPain(Math.max(delayNow, finalDelay)))}</button>` : ''}
      </div>
    </div>
    ${unknown || R.canceled ? '' : `<div class="profile">${profileSvg(m, r, trip, now)}</div>`}
    ${
      shown.length
        ? `<h3 class="block-title">Wo die Verspätung entstand</h3><ul class="buildup">${shown
            .map((b) => `<li><span class="delta ${b.minutes < 0 ? 'is-gain' : ''}">${b.minutes > 0 ? '+' : ''}${Math.round(b.minutes)}′</span><span>${esc(b.text)}</span></li>`)
            .join('')}</ul>`
        : ''
    }
    <h3 class="block-title">Fahrtverlauf</h3>
    <ol class="stops">${stops}</ol>`;
}

// --- Abfahrtstafel -------------------------------------------------------------

/** Übliche Abfahrtsverspätung einer Linie an einem Bahnhof: [Abfahrten, Median, 80-%-Wert] */
export type TypicalDelay = (station: string, line: string) => [number, number, number] | undefined;

export interface BoardOptions {
  mode: 'dep' | 'arr';
  /** Echtzeitdaten (sonst Simulation) */
  live: boolean;
  typical?: TypicalDelay;
  /** Regionalzüge für diesen Bahnhof werden noch geladen */
  loading?: boolean;
}

const BOARD_WINDOW = 180;
const BOARD_ROWS = 40;

/** Bis zu drei wichtige Unterwegshalte (nach Zughalten pro Tag), in Fahrtrichtung. */
function viaStops(m: DayModel, stops: number[]): string {
  const ranked = stops.map((s, k) => ({ s, k, w: m.stations[s].w ?? m.stations[s].weight })).sort((a, b) => b.w - a.w).slice(0, 3);
  return ranked
    .sort((a, b) => a.k - b.k)
    .map((x) => shortName(m.stations[x.s].name))
    .join(' · ');
}

interface BoardStatus {
  text: string;
  sub: string;
  c: string;
  title?: string;
  /** erwartete Zusatzminuten (für die Zusammenfassung) */
  expect: number;
  live: boolean;
}

function boardStatus(m: DayModel, r: SimResult, trip: number, i: number, station: number, o: BoardOptions): BoardStatus {
  const T = m.trips[trip];
  const R = r.trips[trip];
  const dep = o.mode === 'dep';
  if (R.canceled) return { text: 'fällt aus', sub: '', c: 'var(--bad)', expect: 0, live: true };
  if (R.known !== false) {
    const d = dep ? R.dep[i] - T.schedDep[i] : R.arr[i] - T.schedArr[i];
    const seen = (R.observed?.[i] ?? 0) & (dep ? OBS_DEP : OBS_ARR);
    return {
      text: d >= 1 ? `+${Math.round(d)}` : 'pünktlich',
      sub: !o.live ? 'Simulation' : seen ? (dep ? 'abgefahren' : 'angekommen') : 'Prognose',
      c: delayColor(d),
      expect: Math.max(0, d),
      live: true,
    };
  }
  // Keine Echtzeit (Zug noch nicht unterwegs): was diese Linie hier üblicherweise hat
  const t = dep ? o.typical?.(m.stations[station].name, T.line) : undefined;
  const title = t ? `${t[0]} Abfahrten beobachtet: meist +${t[1]} Min, jede fünfte +${t[2]} Min oder mehr` : undefined;
  if (t && t[1] >= 2) return { text: `+${t[1]}`, sub: 'meist', c: 'color-mix(in srgb, var(--warn) 70%, var(--muted))', title, expect: t[1], live: false };
  return { text: 'planmäßig', sub: t ? 'meist pünktlich' : '', c: 'var(--muted)', title, expect: 0, live: false };
}

/** Abfahrts- bzw. Ankunftstafel mit erwarteter Verspätung: live, sonst aus der Historie. */
export function departureBoard(m: DayModel, r: SimResult, station: number, now: number, o: BoardOptions): string {
  const dep = o.mode === 'dep';
  const rows: { trip: number; i: number; sched: number; act: number }[] = [];
  const seen = new Set<string>();
  for (const T of m.trips) {
    const i = T.stops.indexOf(station);
    if (i < 0 || (dep ? i === T.stops.length - 1 : i === 0)) continue;
    const R = r.trips[T.id];
    const sched = dep ? T.schedDep[i] : T.schedArr[i];
    const act = R.canceled ? sched : dep ? R.dep[i] : R.arr[i];
    if (act < now - 0.5 || sched > now + BOARD_WINDOW) continue;
    // Manche Züge stehen in Fern- und Regionalfeed
    const key = `${T.line}|${sched}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ trip: T.id, i, sched, act });
  }
  rows.sort((a, b) => a.sched - b.sched || a.trip - b.trip);
  const shown = rows.slice(0, BOARD_ROWS);
  const status = shown.map((x) => boardStatus(m, r, x.trip, x.i, station, o));

  const html = shown
    .map((x, k) => {
      const T = m.trips[x.trip];
      const s = status[k];
      const end = dep ? T.stops[T.stops.length - 1] : T.stops[0];
      const via = dep ? T.stops.slice(x.i + 1, -1) : T.stops.slice(1, x.i);
      const late = s.live && s.expect >= 1 && !r.trips[x.trip].canceled;
      return `<li class="dep${r.trips[x.trip].canceled ? ' is-canceled' : ''}" data-trip="${x.trip}">
        <span class="dep-time"><b>${hhmm(x.sched)}</b>${late ? `<span style="color:${s.c}">${hhmm(x.act)}</span>` : ''}</span>
        <span class="dep-main">
          <span class="dep-head">${lineBadge(m, x.trip)}<span class="dep-dest">${dep ? '' : '<small>von </small>'}${esc(shortName(m.stations[end].name))}</span></span>
          ${via.length ? `<span class="dep-via">${dep ? 'über ' : ''}${esc(viaStops(m, via))}</span>` : ''}
        </span>
        <span class="dep-status" style="--c:${s.c}"${s.title ? ` title="${esc(s.title)}"` : ''}><b>${s.text}</b>${s.sub ? `<small>${s.sub}</small>` : ''}</span>
      </li>`;
    })
    .join('');

  const hour = shown.filter((x) => x.sched <= now + 60);
  const hourLate = hour.filter((x) => status[shown.indexOf(x)].expect >= 5).length;
  const hourLive = hour.filter((x) => status[shown.indexOf(x)].live).length;
  const canceled = shown.filter((x) => r.trips[x.trip].canceled).length;
  const summary = hour.length
    ? `${hour.length} ${dep ? (hour.length === 1 ? 'Abfahrt' : 'Abfahrten') : hour.length === 1 ? 'Ankunft' : 'Ankünfte'} in der nächsten Stunde · ${
        hourLate ? `<b style="color:var(--late)">${hourLate} voraussichtlich 5+ Min später</b>` : '<b style="color:var(--ok)">alles im Plan</b>'
      }${canceled ? ` · <b style="color:var(--bad)">${canceled} ${canceled === 1 ? 'Ausfall' : 'Ausfälle'}</b>` : ''} · Live-Daten für ${hourLive}`
    : '';

  return `<div class="board">
    <div class="board-top"><p class="board-title">${esc(shortName(m.stations[station].name))}</p><span class="board-clock">${hhmm(now)}</span></div>
    ${summary ? `<p class="board-summary">${summary}</p>` : ''}
    ${
      html
        ? `<ul class="deps">${html}</ul>`
        : `<p class="board-empty">${o.loading ? 'Lade Züge für diesen Bahnhof …' : `Keine ${dep ? 'Abfahrten' : 'Ankünfte'} in den nächsten drei Stunden.`}</p>`
    }
  </div>
  ${o.loading && html ? '<p class="fine">Regionalzüge werden noch geladen …</p>' : ''}`;
}

// --- Suche -------------------------------------------------------------------

export function stationRow(m: DayModel, station: number, distanceKm?: number): string {
  const st = m.stations[station];
  return `<li class="row" data-station="${station}">
    <span class="pin" style="--c:var(--lamp)">◆</span>
    <span class="row-main"><span class="row-title">${esc(st.name)}</span><span class="row-sub">${distanceKm !== undefined ? `${distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(1).replace('.', ',')} km`} entfernt · ` : ''}Abfahrtstafel öffnen</span></span>
    <span></span>
  </li>`;
}

export function searchHitRow(m: DayModel, r: SimResult, hit: TripHit): string {
  const T = m.trips[hit.trip];
  const R = r.trips[hit.trip];
  const at = shortName(m.stations[T.stops[hit.stop]].name);
  const d = hit.stop === T.stops.length - 1 ? R.arr[hit.stop] - T.schedArr[hit.stop] : R.dep[hit.stop] - T.schedDep[hit.stop];
  const known = R.known !== false;
  const status = R.canceled ? 'fällt aus' : hit.status === 'running' ? 'unterwegs' : hit.status === 'upcoming' ? 'kommt noch' : 'angekommen';
  const c = R.canceled ? 'var(--bad)' : known ? delayColor(d) : 'var(--nodata)';
  return `<li class="row" data-trip="${hit.trip}">
    ${lineBadge(m, hit.trip)}
    <span class="row-main"><span class="row-title">${esc(endpoints(m, hit.trip))}</span><span class="row-sub">${hit.stop === 0 ? 'ab' : 'in'} ${esc(at)} ${hhmm(hit.time)} · ${status}</span></span>
    <span class="delay" style="--c:${c}">${R.canceled ? '✕' : known ? fmtDelay(d) : '–'}</span>
  </li>`;
}

// --- Verbindungen ------------------------------------------------------------

const chanceColor = (p: number) => (p >= 0.9 ? 'var(--ok)' : p >= 0.7 ? '#a3e635' : p >= 0.4 ? 'var(--warn)' : 'var(--bad)');
export const chanceLabel = (p: number) => (p >= 0.9 ? 'sicher' : p >= 0.7 ? 'wahrscheinlich' : p >= 0.4 ? 'knapp' : p >= 0.1 ? 'riskant' : 'kaum zu schaffen');

const duration = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')} h`;

/** Bisherige Beobachtungen eines Umstiegs: [Anzahl, verpasst] */
export type TransferHistory = (station: string, from: string, to: string) => [number, number] | undefined;

export function journeyCard(m: DayModel, j: Journey, recommended: boolean, now: number, history?: TransferHistory): string {
  const late = j.predArr - j.schedArr;
  const legs = j.legs
    .map((l, i) => {
      const T = m.trips[l.trip];
      const via = i < j.legs.length - 1 ? `<span>→ ${esc(shortName(m.stations[T.stops[l.to]].name))} →</span>` : '';
      return `<span class="line-badge" data-cat="${esc(T.category)}" data-trip="${l.trip}" role="button" tabindex="0">${esc(T.line)}</span>${via}`;
    })
    .join('');
  const transfers = j.transfers
    .map((t, k) => {
      const c = chanceColor(t.probability);
      const pred = Math.round(t.predicted);
      const h = history?.(m.stations[t.station].name, m.trips[j.legs[k].trip].line, m.trips[j.legs[k + 1].trip].line);
      const hist = h ? `<span class="fine" style="grid-column:1/-1;margin:0">Bisher ${h[0] - h[1]} von ${h[0]} Mal geklappt</span>` : '';
      return `<div class="chance" style="--c:${c}">
        <span>Umstieg ${esc(shortName(m.stations[t.station].name))}: geplant ${Math.round(t.planned)} Min, ${t.uncertain ? 'ohne Echtzeitdaten' : `heute ${pred < 0 ? `${-pred} Min zu spät` : `${pred} Min`}`} (nötig ${t.needed})</span>
        <b>${Math.round(t.probability * 100)} % · ${chanceLabel(t.probability)}</b>
        <span class="chance-bar"><span style="width:${Math.max(3, t.probability * 100)}%"></span></span>
        ${hist}
      </div>`;
    })
    .join('');
  const past = j.predDep < now - 0.5;
  return `<article class="journey${recommended ? ' is-recommended' : ''}${past ? ' is-past' : ''}">
    <div class="journey-top">
      <span class="journey-times">${hhmm(j.schedDep)} → ${hhmm(j.schedArr)}${!j.canceled && late >= 1 ? `<small style="color:${delayColor(late)}">+${Math.round(late)}</small>` : ''}</span>
      ${recommended ? '<span class="pill" style="--c:var(--lamp)">Empfohlen</span>' : j.canceled ? '<span class="pill" style="--c:var(--bad)">Fällt aus</span>' : ''}
    </div>
    <div class="journey-meta">${duration(j.schedArr - j.schedDep)} · ${j.legs.length === 1 ? 'direkt' : `${j.legs.length - 1} Umstieg${j.legs.length > 2 ? 'e' : ''}`}${!j.canceled && late >= 1 ? ` · Ankunft voraussichtlich ${hhmm(j.predArr)}` : ''}</div>
    <div class="journey-legs">${legs}</div>
    ${transfers}
  </article>`;
}

export function journeyVerdict(m: DayModel, res: JourneyResult): string {
  const { journeys, recommended } = res;
  if (recommended < 0) return '';
  const rec = journeys[recommended];
  const earliest = journeys.findIndex((j) => !j.canceled && j.predDep >= rec.predDep - 120 && j.schedArr < rec.schedArr);
  const recText = `${hhmm(rec.schedDep)} mit ${rec.legs.map((l) => m.trips[l.trip].line).join(' → ')}`;
  if (earliest >= 0 && earliest !== recommended) {
    const fast = journeys[earliest];
    const weak = fast.transfers.reduce((a, b) => (b.probability < a.probability ? b : a), fast.transfers[0]);
    return `<div class="verdict"><strong>Nimm lieber ${esc(recText)}.</strong>Die planmäßig schnellere Verbindung um ${hhmm(fast.schedDep)} ist heute ${fast.canceled ? 'ausgefallen' : `riskant: Der Umstieg in ${esc(shortName(m.stations[weak.station].name))} klappt nur zu ${Math.round(weak.probability * 100)} %`}. Voraussichtliche Ankunft mit der Empfehlung: ${hhmm(rec.predArr)}.</div>`;
  }
  const tr = rec.transfers.length ? ` Umstieg${rec.transfers.length > 1 ? 'e' : ''} ${rec.transfers.map((t) => `${shortName(m.stations[t.station].name)} ${Math.round(t.probability * 100)} %`).join(', ')}.` : ' Ohne Umstieg.';
  return `<div class="verdict"><strong>${esc(recText)} passt.</strong>Voraussichtliche Ankunft ${hhmm(rec.predArr)}.${esc(tr)}</div>`;
}

// --- Share my Train (Pain) ---------------------------------------------------------

/** "Share my Train" – bei großer Verspätung wird Train durchgestrichen und Pain kommt dazu */
export const shareBrand = (pain: boolean) =>
  pain ? `<span class="brand is-pain">Share my <s>Train</s> <b>Pain</b></span>` : `<span class="brand">Share my <b>Train</b></span>`;

/** Formular zum Teilen der eigenen Zugfahrt: Ausstieg wählen, Name optional. */
export function sharePanel(m: DayModel, trip: number, fromStop: number, name: string, pain: boolean): string {
  const T = m.trips[trip];
  // Eingestiegen: irgendwo bis zum aktuellen Halt
  const boards = T.stops
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => i <= fromStop && i < T.stops.length - 1)
    .map(({ s, i }) => `<option value="${i}"${i === 0 ? ' selected' : ''}>${esc(m.stations[s].name)} · ${hhmm(T.schedDep[i])}</option>`)
    .join('');
  const options = T.stops
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => i > fromStop)
    .map(({ s, i }) => `<option value="${i}"${i === T.stops.length - 1 ? ' selected' : ''}>${esc(m.stations[s].name)} · ${hhmm(T.schedArr[i])}</option>`)
    .join('');
  return `<section class="share-card">
    <h3 class="share-title">${shareBrand(pain)}</h3>
    <p class="fine">Schick deinen Liebsten einen Link: Sie sehen live, wo dein Zug gerade ist und wann du ankommst. Geteilt wird nur der Zug, nicht dein Standort.</p>
    <div class="share-route">
      <label class="field"><span class="eyebrow">Eingestiegen in</span><select id="share-from">${boards}</select></label>
      <label class="field"><span class="eyebrow">Ich steige aus in</span><select id="share-to">${options}</select></label>
    </div>
    <p class="share-co2" id="share-co2"></p>
    <label class="field"><span class="eyebrow">Dein Name (optional)</span><input id="share-name" type="text" maxlength="20" placeholder="z. B. Tobi" autocomplete="given-name" value="${esc(name)}" /></label>
    <div class="share-actions">
      <button class="cta cta--small" id="share-go">Link teilen</button>
      <button class="ghost-btn" id="share-copy">Link kopieren</button>
    </div>
    <p class="fine" id="share-result" role="status"></p>
  </section>`;
}

/** Ansicht für Empfänger eines geteilten Links */
export function followCard(st: FollowStatus, who: string, stamp: number): string {
  const c = st.state === 'canceled' ? 'var(--bad)' : st.known ? delayColor(st.delay) : 'var(--accent)';
  const subject = who ? esc(who) : 'Der Zug';
  const head =
    st.state === 'canceled'
      ? `${esc(st.line)} nach ${esc(st.to)} fällt aus`
      : st.state === 'arrived'
        ? `${subject} ist um <b>${hhmm(st.estArr)}</b> in <b>${esc(st.target)}</b> angekommen`
        : `${subject} kommt um <b>${hhmm(st.estArr)}</b> in <b>${esc(st.target)}</b> an`;
  const delay =
    st.state === 'canceled'
      ? 'Bitte nach einer anderen Verbindung schauen.'
      : !st.known
        ? `Planmäßig ${hhmm(st.schedArr)}, noch keine Echtzeitdaten`
        : st.delay >= 1
          ? `${st.delay} Min später als geplant (${hhmm(st.schedArr)})`
          : 'Pünktlich';
  const left = st.minutesLeft >= 60 ? `${Math.floor(st.minutesLeft / 60)} h ${st.minutesLeft % 60} Min` : `${st.minutesLeft} Min`;
  const pct = (st.progress * 100).toFixed(1);
  const pain = isPain(st.delay, st.state === 'canceled');
  return `<section class="follow${pain ? ' is-pain' : ''}" style="--c:${c}">
    <span class="follow-brand">${shareBrand(pain)}<span class="follow-line"><span class="live-dot"></span>${esc(st.line)} live</span></span>
    <p class="follow-head">${head}</p>
    <p class="follow-delay">${delay}</p>
    <div class="follow-bar" role="img" aria-label="${Math.round(st.progress * 100)} % der Strecke geschafft"><span style="width:${pct}%"></span><i style="left:${pct}%"></i></div>
    <div class="follow-ends"><span>${esc(st.board)}</span><span>${esc(st.target)}</span></div>
    <p class="follow-where">${st.state === 'running' || st.state === 'before' ? `${esc(st.where.charAt(0).toUpperCase() + st.where.slice(1))}${st.next && st.next.name !== st.target ? ` · nächster Halt ${esc(st.next.name)} ${hhmm(st.next.time)}` : ''} · noch ${left}` : esc(st.where.charAt(0).toUpperCase() + st.where.slice(1))}</p>
    ${co2Line(st) ? `<p class="follow-co2">${esc(co2Line(st))}</p>` : ''}
    <p class="fine">Aktualisiert sich automatisch, Stand ${hhmm(stamp)}. Geteilt wurde nur der Zug, kein Standort. CO₂-Werte: Umweltbundesamt, Bezugsjahr 2024.</p>
  </section>`;
}
