import type { LiveHotspot, TrainState } from '../sim/live.ts';
import type { DayModel } from '../sim/model.ts';
import { INCIDENT_LABEL, fmtDelay, hhmm, incidentPlace, shortName } from '../sim/text.ts';
import type { Incident, SimResult } from '../sim/types.ts';
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

export function stationBoard(m: DayModel, r: SimResult, station: number, now: number): string {
  const deps: { trip: number; sched: number; act: number; to: string; known: boolean }[] = [];
  for (const T of m.trips) {
    const i = T.stops.indexOf(station);
    if (i < 0 || i === T.stops.length - 1) continue;
    const R = r.trips[T.id];
    if (R.canceled) continue;
    const act = R.dep[i];
    if (act < now - 1 || T.schedDep[i] > now + 120) continue;
    deps.push({ trip: T.id, sched: T.schedDep[i], act, to: shortName(m.stations[T.stops[T.stops.length - 1]].name), known: R.known !== false });
  }
  deps.sort((a, b) => a.sched - b.sched);
  const rows = deps
    .slice(0, 16)
    .map((d) => {
      const late = d.act - d.sched;
      const cls = !d.known ? '' : late >= 6 ? 'late' : 'ok';
      return `<tr data-trip="${d.trip}"><td>${hhmm(d.sched)}</td><td>${esc(m.trips[d.trip].line)}</td><td class="dest">${esc(d.to)}</td><td class="${cls}">${d.known ? (late >= 1 ? `+${Math.round(late)}` : 'pünktl.') : ''}</td></tr>`;
    })
    .join('');
  return `<div class="board">
    <p class="board-title">${esc(shortName(m.stations[station].name))}</p>
    ${rows ? `<table><tbody>${rows}</tbody></table>` : '<p class="fine">Keine Fernverkehrsabfahrten in den nächsten zwei Stunden.</p>'}
  </div>`;
}
