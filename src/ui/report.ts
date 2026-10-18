import type { DailyReport, Objective, Suggestion } from '../sim/analysis.ts';
import { MAX_MISS_PENALTY, type DayModel } from '../sim/model.ts';
import { CAUSE_LABEL, INCIDENT_LABEL, fmtInt, fmtPct, hhmm, incidentPlace, shortName, tripLabel } from '../sim/text.ts';
import type { Cause } from '../sim/types.ts';
import { esc } from './dom.ts';

const GRADES = [
  { min: 0.85, grade: 'A', color: '#4ade80', text: 'Souverän disponiert.' },
  { min: 0.78, grade: 'B', color: '#a3e635', text: 'Solider Tag mit einzelnen Brennpunkten.' },
  { min: 0.7, grade: 'C', color: '#facc15', text: 'Durchwachsen – das Netz war spürbar unter Druck.' },
  { min: 0.62, grade: 'D', color: '#fb923c', text: 'Harter Tag. Mehrere Störungen haben sich durchs Netz gefressen.' },
  { min: 0, grade: 'E', color: '#f43f5e', text: 'Chaos-Tag. Hier lohnt sich jede bessere Entscheidung doppelt.' },
];

export const gradeOf = (punctuality: number) => GRADES.find((g) => punctuality >= g.min)!;

function suggestionText(m: DayModel, r: DailyReport, s: Suggestion): { tag: string; what: string; why: string } {
  const station = esc(shortName(m.stations[s.station].name));
  const [a, b] = s.trips;
  if (s.kind === 'hold' || s.kind === 'release') {
    const c = m.connections[s.connection!];
    if (s.kind === 'hold') {
      const lastOne = c.missPenalty >= MAX_MISS_PENALTY;
      return {
        tag: 'Anschluss halten',
        what: `${hhmm(s.time)} ${station}: ${esc(tripLabel(m, a))} hätte ${Math.max(1, Math.round(s.cost))} Min auf ${esc(tripLabel(m, b))} warten sollen.`,
        why: lastOne
          ? `Ca. ${c.passengers} Umsteiger haben den letzten Anschluss des Tages verpasst.`
          : `Ca. ${c.passengers} Umsteiger kamen mit der nächsten Verbindung ${Math.round(c.missPenalty)} Min später an.`,
      };
    }
    return {
      tag: 'Nicht warten',
      what: `${hhmm(s.time)} ${station}: ${esc(tripLabel(m, a))} hätte nicht auf ${esc(tripLabel(m, b))} warten sollen.`,
      why: `${Math.round(-s.cost)} Min Wartezeit für einen vollen Zug und seine Folgezüge, für ca. ${c.passengers} Umsteiger mit Alternative in ${Math.round(c.missPenalty)} Min.`,
    };
  }
  const L = m.trips[a], F = m.trips[b];
  const li = L.stops.indexOf(s.station), fi = F.stops.indexOf(s.station);
  const ld = Math.round(r.baseRun.trips[a].dep[li] - L.schedDep[li]);
  const fd = Math.max(0, Math.round(r.baseRun.trips[b].arr[fi] - F.schedArr[fi]));
  const next = shortName(m.stations[F.stops[fi + 1]].name);
  return {
    tag: 'Überholung',
    what: `${hhmm(s.time)} ${station}: ${esc(tripLabel(m, a))} (+${ld}) hätte ${esc(tripLabel(m, b))} (+${fd}) vorlassen sollen.`,
    why: `Der verspätete Zug hat den fast pünktlichen Folgezug Richtung ${esc(next)} ausgebremst.`,
  };
}

function gainLabel(s: Suggestion, objective: Objective): string {
  const pp = `${s.punctualityDelta >= 0 ? '+' : ''}${s.punctualityDelta.toFixed(2).replace('.', ',')} Pp`;
  const hours = s.savedPassengerMinutes / 60;
  const h = `${hours >= 0 ? '−' : '+'}${fmtInt(Math.abs(hours))} Fahrgast-Std.`;
  return objective === 'punctuality' ? `${pp} Pünktlichkeit<span>${h}</span>` : `${h}<span>${pp} Pünktlichkeit</span>`;
}

const CAUSE_COLORS: Record<Cause['type'], string> = {
  incident: '#f43f5e',
  knockon: '#fb923c',
  ops: '#8393ad',
  origin: '#a78bfa',
  connection: '#7dd3fc',
  dwell: '#facc15',
  yield: '#4ade80',
};

export function renderReport(m: DayModel, r: DailyReport, opts: { partial: boolean; objective: Objective }): string {
  const g = gradeOf(r.base.punctuality);
  const plan = r.plans[opts.objective];
  const optimized = plan.metrics;
  const savedPct = r.base.passengerDelayMinutes > 0 ? (r.base.passengerDelayMinutes - optimized.passengerDelayMinutes) / r.base.passengerDelayMinutes : 0;
  const punctDelta = (optimized.punctuality - r.base.punctuality) * 100;
  const causeTotal = Object.values(r.base.causeMinutes).reduce((a, b) => a + b, 0) || 1;
  const causes = (Object.entries(r.base.causeMinutes) as [Cause['type'], number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const maxCause = causes[0]?.[1] ?? 1;
  const appliedSet = new Set(plan.applied);
  const gain = (s: Suggestion) => (opts.objective === 'passengers' ? s.savedPassengerMinutes : s.punctualityDelta);
  const ranked = r.suggestions.filter((s) => gain(s) > 0).sort((a, b) => gain(b) - gain(a));

  const suggestions = ranked.slice(0, 10).map((s, i) => {
    const t = suggestionText(m, r, s);
    const kindClass = s.kind === 'hold' ? 'tag--hold' : s.kind === 'release' ? 'tag--release' : 'tag--yield';
    return `<div class="suggestion${appliedSet.has(s) ? ' is-applied' : ''}">
      <div class="rank">${i + 1}</div>
      <div>
        <div class="what"><span class="tag ${kindClass}">${t.tag}</span>${t.what}</div>
        <div class="why">${t.why}</div>
        <button class="pix-btn" data-show-trip="${s.trips[0]}" data-show-time="${Math.max(0, s.time - 12)}">Auf Karte zeigen</button>
      </div>
      <div class="gain">${gainLabel(s, opts.objective)}</div>
    </div>`;
  });

  return `
    ${opts.partial ? `<p class="fine">Hochrechnung für den laufenden Tag: Die Simulation kennt den restlichen Tag bereits. Den endgültigen Bericht gibt es ab 03:00 Uhr unter „Gestern“.</p>` : ''}
    <div class="grade-row">
      <div class="grade" style="--c:${g.color}">${g.grade}</div>
      <div>
        <p style="font-size:24px">${g.text}</p>
        <p class="fine">${fmtInt(m.trips.length)} Fernverkehrsfahrten · ${fmtInt(r.base.arrivals)} Ankünfte in Deutschland · ${r.simulations} Simulationsläufe für die Gegenrechnung</p>
      </div>
    </div>

    <h3>Bilanz: so lief es · so wäre es gegangen</h3>
    <div class="objective" role="group" aria-label="Optimierungsziel">
      <span class="fine">Ziel des Leitstands:</span>
      <button class="pix-btn${opts.objective === 'punctuality' ? ' is-active' : ''}" data-objective="punctuality">Pünktlichkeit</button>
      <button class="pix-btn${opts.objective === 'passengers' ? ' is-active' : ''}" data-objective="passengers">Fahrgäste</button>
    </div>
    <div class="compare">
      <div class="kpi"><span class="kpi-label">Pünktlichkeit</span><span class="kpi-value">${fmtPct(r.base.punctuality)}</span><span class="kpi-hint">mit Vorschlägen ${fmtPct(optimized.punctuality)} (${punctDelta >= 0 ? '+' : ''}${punctDelta.toFixed(1).replace('.', ',')} Pp)</span></div>
      <div class="kpi"><span class="kpi-label">Fahrgast-Verspätung</span><span class="kpi-value">${fmtInt(r.base.passengerDelayMinutes / 60)} h</span><span class="kpi-hint">mit Vorschlägen ${fmtInt(optimized.passengerDelayMinutes / 60)} h (−${fmtPct(savedPct, 0)})</span></div>
      <div class="kpi"><span class="kpi-label">Anschlüsse verpasst</span><span class="kpi-value">${fmtInt(r.base.missedConnections)}</span><span class="kpi-hint">ca. ${fmtInt(r.base.strandedPassengers)} Umsteiger · mit Vorschlägen ${fmtInt(optimized.missedConnections)}</span></div>
      <div class="kpi"><span class="kpi-label">Ø Verspätung</span><span class="kpi-value">${r.base.avgDelay.toFixed(1).replace('.', ',')} Min</span><span class="kpi-hint">je Ankunft</span></div>
    </div>
    <p class="fine">Pünktlichkeit zählt Züge, Fahrgast-Verspätung zählt Menschen. Einen Anschluss zu halten kostet oft ein paar Zehntel Pünktlichkeit, erspart Umsteigern aber eine Stunde. Wechsle das Ziel und sieh, wie sich die Empfehlungen ändern.</p>

    <h3>Top-Vorschläge für den Leitstand</h3>
    ${suggestions.length ? suggestions.join('') : '<p class="fine">Keine Entscheidung hätte heute spürbar geholfen.</p>'}
    <p class="fine">Grün umrandet: in der Kombination übernommen (${plan.applied.length} Entscheidungen). Jeder Vorschlag ist eine komplette Neusimulation des Tages mit genau dieser einen Änderung.</p>

    <h3>Woher die Verspätungen kamen</h3>
    <div class="bars">
      ${causes
        .map(
          ([k, v]) => `<div class="bar"><span>${CAUSE_LABEL[k]}</span><div class="bar-track"><div class="bar-fill" style="width:${((v / maxCause) * 100).toFixed(1)}%;--c:${CAUSE_COLORS[k]}"></div></div><span class="num">${fmtPct(v / causeTotal, 0)}</span></div>`,
        )
        .join('')}
    </div>

    <div class="two-col">
      <div>
        <h3>Teuerste Störungen</h3>
        <table class="table">
          ${r.incidents
            .filter((i) => i.directMinutes > 0)
            .slice(0, 7)
            .map(
              (i) => `<tr><td>${INCIDENT_LABEL[i.incident.kind]}<br><span class="fine">${esc(incidentPlace(m, i.incident))}${i.incident.kind === 'bau' ? ' · ganztägig' : ` · ${hhmm(i.incident.start)}–${hhmm(i.incident.end)}`}</span></td><td class="num">${fmtInt(i.directMinutes)} Min<br><span class="fine">${i.trainsAffected} Züge</span></td></tr>`,
            )
            .join('')}
        </table>
      </div>
      <div>
        <h3>Knoten mit Verspätungszuwachs</h3>
        <table class="table">
          ${r.hotspots
            .slice(0, 7)
            .map((h) => `<tr><td>${esc(m.stations[h.station].name)}</td><td class="num">+${fmtInt(h.minutesGained)} Min<br><span class="fine">${h.trains} Züge</span></td></tr>`)
            .join('')}
        </table>
      </div>
    </div>

    <h3>Verspätungs-Verbreiter</h3>
    <table class="table">
      ${r.spreaders
        .slice(0, 6)
        .map((s) => `<tr><td>${esc(tripLabel(m, s.trip))}</td><td class="num">${fmtInt(s.minutes)} Min Folgeverspätung bei ${s.victims} Zügen</td></tr>`)
        .join('')}
    </table>

    <h3>Wie belastbar ist das?</h3>
    <p class="fine">Die Gegenrechnung nutzt ein vereinfachtes Netzmodell: Mindestzugfolge von 3 Minuten je Abschnitt, kein Überholen auf freier Strecke, Fahrzeitreserven, Umsteigezeit 3 Minuten, geschätzte Fahrgastzahlen je Zuggattung. Nicht modelliert sind Nah- und Güterverkehr, Gleisbelegung in Bahnhöfen, Fahrzeug- und Personalumläufe sowie Umleitungen. Die Vorschläge zeigen, wo sich ein genauer Blick lohnt. Sie sind keine geprüften Dispositionsanweisungen.</p>
  `;
}
