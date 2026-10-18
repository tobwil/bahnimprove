import type { DailyReport, Objective, Suggestion } from '../sim/analysis.ts';
import { MAX_MISS_PENALTY, type DayModel } from '../sim/model.ts';
import { CAUSE_LABEL, INCIDENT_LABEL, fmtInt, fmtPct, hhmm, incidentPlace, shortName, tripLabel } from '../sim/text.ts';
import type { Cause, SimResult } from '../sim/types.ts';
import { esc } from './dom.ts';

const GRADES = [
  { min: 0.85, grade: 'A', color: '#3ee08f', text: 'Souverän disponiert. Das Netz lief rund.' },
  { min: 0.78, grade: 'B', color: '#a3e635', text: 'Solider Tag mit einzelnen Brennpunkten.' },
  { min: 0.7, grade: 'C', color: '#ffd447', text: 'Durchwachsen. Das Netz war spürbar unter Druck.' },
  { min: 0.62, grade: 'D', color: '#ff9a3c', text: 'Harter Tag. Verspätungen haben sich durchs Netz gezogen.' },
  { min: 0, grade: 'E', color: '#ff4f6e', text: 'Chaos-Tag. Hier zählt jede bessere Entscheidung doppelt.' },
];

export const gradeOf = (punctuality: number) => GRADES.find((g) => punctuality >= g.min)!;

function suggestionText(m: DayModel, r: DailyReport, s: Suggestion): { tag: string; kind: string; what: string; why: string } {
  const station = esc(shortName(m.stations[s.station].name));
  const [a, b] = s.trips;
  if (s.kind === 'hold' || s.kind === 'release') {
    const c = m.connections[s.connection!];
    if (s.kind === 'hold') {
      return {
        tag: 'Anschluss halten',
        kind: 'hold',
        what: `${hhmm(s.time)} ${station}: ${esc(tripLabel(m, a))} wartet ${Math.max(1, Math.round(s.cost))} Min auf ${esc(tripLabel(m, b))}.`,
        why:
          c.missPenalty >= MAX_MISS_PENALTY
            ? `Ca. ${c.passengers} Umsteiger haben den letzten Anschluss des Tages verpasst.`
            : `Ca. ${c.passengers} Umsteiger kamen mit der nächsten Verbindung ${Math.round(c.missPenalty)} Min später an.`,
      };
    }
    return {
      tag: 'Nicht warten',
      kind: 'release',
      what: `${hhmm(s.time)} ${station}: ${esc(tripLabel(m, a))} fährt ohne ${esc(tripLabel(m, b))} ab.`,
      why: `${Math.round(-s.cost)} Min Wartezeit für einen vollen Zug und seine Folgezüge, für ca. ${c.passengers} Umsteiger mit Alternative in ${Math.round(c.missPenalty)} Min.`,
    };
  }
  const L = m.trips[a], F = m.trips[b];
  const li = L.stops.indexOf(s.station), fi = F.stops.indexOf(s.station);
  const ld = Math.round(r.baseRun.trips[a].dep[li] - L.schedDep[li]);
  const fd = Math.max(0, Math.round(r.baseRun.trips[b].arr[fi] - F.schedArr[fi]));
  return {
    tag: 'Überholung',
    kind: 'yield',
    what: `${hhmm(s.time)} ${station}: ${esc(tripLabel(m, a))} (+${ld}) lässt ${esc(tripLabel(m, b))} (+${fd}) vor.`,
    why: `Der verspätete Zug hat den fast pünktlichen Folgezug Richtung ${esc(shortName(m.stations[F.stops[fi + 1]].name))} ausgebremst.`,
  };
}

function gainLabel(s: Suggestion, objective: Objective): string {
  const pp = `${s.punctualityDelta >= 0 ? '+' : ''}${s.punctualityDelta.toFixed(2).replace('.', ',')} Pp`;
  const hours = s.savedPassengerMinutes / 60;
  const h = `${hours >= 0 ? '−' : '+'}${fmtInt(Math.abs(hours))} Fahrgast-Std.`;
  return objective === 'punctuality' ? `${pp}<span>${h}</span>` : `${h}<span>${pp}</span>`;
}

const CAUSE_COLORS: Record<Cause['type'], string> = {
  incident: '#ff4f6e',
  knockon: '#ff9a3c',
  ops: '#8b95b8',
  origin: '#b69cff',
  connection: '#8ab4ff',
  dwell: '#ffd447',
  yield: '#3ee08f',
};

const REAL_CAUSE_LABEL: Record<Cause['type'], string> = {
  ...CAUSE_LABEL,
  origin: 'Schon am Startbahnhof',
  ops: 'Unterwegs zwischen Halten',
  dwell: 'Beim Halt',
  knockon: 'Folgeverspätung (Modell)',
};

const signed = (v: number, digits = 1) => {
  const r = Math.abs(v).toFixed(digits);
  return `${+r === 0 ? '±' : v > 0 ? '+' : '−'}${r.replace('.', ',')}`;
};

function incidentTable(m: DayModel, r: DailyReport): string {
  const rows = r.incidents.filter((i) => i.directMinutes > 0).slice(0, 7);
  return `<section class="card"><h3>Teuerste Störungen</h3><table class="table">${rows
    .map(
      (i) =>
        `<tr><td>${INCIDENT_LABEL[i.incident.kind]}<span class="sub">${esc(incidentPlace(m, i.incident))}${i.incident.kind === 'bau' ? ' · ganztägig' : ` · ${hhmm(i.incident.start)}–${hhmm(i.incident.end)}`}</span></td><td class="num">${fmtInt(i.directMinutes)} Min<span class="sub">${i.trainsAffected} Züge</span></td></tr>`,
    )
    .join('')}</table></section>`;
}

function worstTrains(m: DayModel, observed: SimResult): string {
  const rows = m.trips
    .filter((t) => observed.trips[t.id].known !== false && !observed.trips[t.id].canceled)
    .map((t) => {
      const R = observed.trips[t.id];
      let worst = 0, at = 0;
      t.stops.forEach((_, i) => {
        const d = i === 0 ? R.dep[0] - t.schedDep[0] : R.arr[i] - t.schedArr[i];
        if (d > worst) { worst = d; at = i; }
      });
      return { t, worst, at };
    })
    .sort((a, b) => b.worst - a.worst)
    .slice(0, 7);
  return `<section class="card"><h3>Größte Verspätungen</h3><table class="table">${rows
    .map((x) => `<tr data-show-trip="${x.t.id}" data-show-time="${Math.max(0, x.t.schedDep[x.at] - 10)}"><td>${esc(tripLabel(m, x.t.id))}<span class="sub">in ${esc(shortName(m.stations[x.t.stops[x.at]].name))}</span></td><td class="num">+${fmtInt(x.worst)} Min</td></tr>`)
    .join('')}</table></section>`;
}

export function renderReport(m: DayModel, r: DailyReport, opts: { partial: boolean; objective: Objective; observed?: SimResult }): { html: string; color: string } {
  const real = r.mode === 'real';
  const labels = real ? REAL_CAUSE_LABEL : CAUSE_LABEL;
  const g = gradeOf(r.base.punctuality);
  const plan = r.plans[opts.objective];
  const opt = plan.metrics;
  const punctDelta = (opt.punctuality - r.base.punctuality) * 100;
  const savedHours = (r.base.passengerDelayMinutes - opt.passengerDelayMinutes) / 60;
  const causeTotal = Object.values(r.base.causeMinutes).reduce((a, b) => a + b, 0) || 1;
  const causes = (Object.entries(r.base.causeMinutes) as [Cause['type'], number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const maxCause = causes[0]?.[1] ?? 1;
  const appliedSet = new Set(plan.applied);
  const gain = (s: Suggestion) => (opts.objective === 'passengers' ? s.savedPassengerMinutes : s.punctualityDelta);
  const ranked = r.suggestions.filter((s) => gain(s) > 0).sort((a, b) => gain(b) - gain(a));

  const suggestions = ranked.slice(0, 10).map((s, i) => {
    const t = suggestionText(m, r, s);
    return `<article class="suggestion${appliedSet.has(s) ? ' is-applied' : ''}">
      <div class="rank">${i + 1}</div>
      <div>
        <div class="what"><span class="tag tag--${t.kind}">${t.tag}</span>${t.what}</div>
        <div class="why">${t.why}</div>
        <div class="suggestion-foot">
          <span class="gain">${gainLabel(s, opts.objective)}</span>
          <button class="ghost-btn" data-show-trip="${s.trips[0]}" data-show-time="${Math.max(0, s.time - 12)}">Szene ansehen</button>
        </div>
      </div>
    </article>`;
  });

  const note = opts.partial
    ? real
      ? 'Zwischenstand aus den bisher gesammelten Echtzeitmeldungen, inklusive Prognosen für Züge, die gerade unterwegs sind.'
      : 'Hochrechnung: Die Simulation kennt den restlichen Tag bereits.'
    : '';

  const html = `
    <section class="hero-grade">
      <span class="eyebrow">${real ? 'Echte Ist-Daten' : 'Simulierter Tag'} · ${fmtInt(r.base.arrivals)} Ankünfte in Deutschland</span>
      <div class="hero-letter" style="--c:${g.color}">${g.grade}</div>
      <div class="hero-text">${g.text}</div>
      ${note ? `<p class="fine">${note}</p>` : ''}
    </section>

    <section class="card">
      <div class="objective">
        <h3 style="margin:0">So lief es · so wäre es gegangen</h3>
        <div class="seg" role="group" aria-label="Ziel des Leitstands">
          <button class="seg-btn${opts.objective === 'punctuality' ? ' is-active' : ''}" data-objective="punctuality">Pünktlichkeit</button>
          <button class="seg-btn${opts.objective === 'passengers' ? ' is-active' : ''}" data-objective="passengers">Fahrgäste</button>
        </div>
      </div>
      <div class="compare">
        <div class="metric"><span class="eyebrow">Pünktlichkeit</span><span class="metric-value">${fmtPct(r.base.punctuality)}</span><span class="metric-after">mit Vorschlägen <b>${fmtPct(opt.punctuality)}</b> (${signed(punctDelta)} Pp)</span></div>
        <div class="metric"><span class="eyebrow">Fahrgast-Verspätung</span><span class="metric-value">${fmtInt(r.base.passengerDelayMinutes / 60)} h</span><span class="metric-after">mit Vorschlägen <b>${Math.round(savedHours) === 0 ? '±0' : `${savedHours > 0 ? '−' : '+'}${fmtInt(Math.abs(savedHours))}`} h</b></span></div>
        <div class="metric"><span class="eyebrow">Anschlüsse verpasst</span><span class="metric-value">${fmtInt(r.base.missedConnections)}</span><span class="metric-after">ca. ${fmtInt(r.base.strandedPassengers)} Umsteiger · danach <b>${fmtInt(opt.missedConnections)}</b></span></div>
        <div class="metric"><span class="eyebrow">Ø Verspätung</span><span class="metric-value">${r.base.avgDelay.toFixed(1).replace('.', ',')}′</span><span class="metric-after">je Ankunft</span></div>
      </div>
      <p class="fine">Pünktlichkeit zählt Züge, Fahrgast-Verspätung zählt Menschen. Einen Anschluss zu halten kostet oft ein paar Zehntel Pünktlichkeit, erspart Umsteigern aber eine Stunde.</p>
    </section>

    <section class="card">
      <h3>Top-Entscheidungen für den Leitstand</h3>
      <div class="suggestions">${suggestions.length ? suggestions.join('') : '<p class="fine">Für dieses Ziel hätte heute keine einzelne Entscheidung spürbar geholfen. Wechsle das Ziel oder sieh dir an, wo die Verspätung entstand.</p>'}</div>
      <p class="fine">Grün umrandet: in der Kombination übernommen (${plan.applied.length} Entscheidungen, ${r.simulations} Simulationsläufe).</p>
    </section>

    <section class="card">
      <h3>${real ? 'Wo die Verspätungen entstanden' : 'Woher die Verspätungen kamen'}</h3>
      <div class="bars">${causes
        .map(
          ([k, v]) =>
            `<div class="bar"><span>${labels[k]}</span><span class="num">${fmtPct(v / causeTotal, 0)}</span><div class="bar-track"><div class="bar-fill" style="width:${((v / maxCause) * 100).toFixed(1)}%;--c:${CAUSE_COLORS[k]}"></div></div></div>`,
        )
        .join('')}</div>
    </section>

    <div class="grid-2">
      ${real && opts.observed ? worstTrains(m, opts.observed) : incidentTable(m, r)}
      <section class="card"><h3>Knoten mit Verspätungszuwachs</h3><table class="table">${r.hotspots
        .slice(0, 7)
        .map((h) => `<tr><td>${esc(shortName(m.stations[h.station].name))}<span class="sub">${h.trains} Züge</span></td><td class="num">+${fmtInt(h.minutesGained)} Min</td></tr>`)
        .join('')}</table></section>
    </div>

    <section class="card">
      <h3>Verspätungs-Verbreiter${real ? ' (laut Modell)' : ''}</h3>
      <table class="table">${r.spreaders
        .slice(0, 6)
        .map((s) => `<tr><td>${esc(tripLabel(m, s.trip))}</td><td class="num">${fmtInt(s.minutes)} Min<span class="sub">bei ${s.victims} Zügen</span></td></tr>`)
        .join('')}</table>
    </section>

    <section class="card">
      <h3>Wie belastbar ist das?</h3>
      ${real ? `<p class="fine">Die Ist-Zeiten stammen aus dem GTFS-Realtime-Feed von gtfs.de (DELFI). Für die Gegenrechnung wird der echte Tag in Verspätungszuwächse je Abschnitt und Halt zerlegt und im Netzmodell nachgespielt. Jeder Vorschlag ist die Differenz zweier Modellläufe, übertragen auf die echten Zahlen. Gründe für Verspätungen enthält der Feed nicht.</p>` : ''}
      <p class="fine">Das Netzmodell ist vereinfacht: 3 Minuten Mindestzugfolge je Abschnitt, kein Überholen auf freier Strecke, 3 Minuten Umsteigezeit, geschätzte Fahrgastzahlen je Zuggattung. Nah- und Güterverkehr, Gleisbelegung, Umläufe und Umleitungen fehlen. Die Vorschläge zeigen, wo sich ein genauer Blick lohnt. Geprüfte Dispositionsanweisungen sind sie nicht.</p>
    </section>`;
  return { html, color: g.color };
}
