import type { Confidence, Finding, FindingKind, Insights } from '../insights/aggregate.ts';
import { fmtInt, fmtPct } from '../sim/text.ts';
import { esc } from './dom.ts';
import { REASON_GROUPS, reasonGroup, reasonText, type ReasonGroup } from '../insights/reasons.ts';

const GROUPS: { kind: FindingKind; title: string; lead: string }[] = [
  { kind: 'section', title: 'Fahrzeiten ehrlich planen', lead: 'Abschnitte, auf denen Züge Tag für Tag Zeit verlieren. Der Fahrplan verspricht hier mehr, als die Strecke hergibt.' },
  { kind: 'dwell', title: 'Haltezeiten', lead: 'Bahnhöfe, an denen der Fahrgastwechsel regelmäßig länger dauert als geplant.' },
  { kind: 'origin', title: 'Pünktlich starten', lead: 'Startbahnhöfe, an denen Züge schon mit Verspätung losfahren. Jede Minute hier zieht sich durch die ganze Fahrt.' },
  { kind: 'transfer', title: 'Anschlüsse', lead: 'Umstiege, die auf dem Papier funktionieren, in der Praxis aber oft platzen.' },
  { kind: 'import', title: 'Verspätung aus dem Ausland', lead: 'Züge, die ihre Verspätung über die Grenze mitbringen.' },
  { kind: 'reserve', title: 'Hier steckt Reserve', lead: 'Abschnitte, auf denen Züge regelmäßig aufholen. Diese Puffer ließen sich dorthin verlagern, wo sie fehlen.' },
];

const CONF: Record<Confidence, { label: string; color: string }> = {
  belastbar: { label: 'Belastbar', color: 'var(--ok)' },
  hinweis: { label: 'Hinweis', color: 'var(--warn)' },
  vorläufig: { label: 'Vorläufig', color: 'var(--dim)' },
};

function card(f: Finding): string {
  const c = CONF[f.confidence];
  return `<article class="insight">
    <div class="insight-head"><span class="insight-place">${esc(f.place)}</span><span class="pill" style="--c:${c.color}">${c.label}</span></div>
    <div class="insight-evidence">${esc(f.evidence)}</div>
    ${f.reasons ? `<div class="insight-evidence">Gemeldete Gründe hier: ${esc(f.reasons)}</div>` : ''}
    <div class="insight-measure">${esc(f.measure)}</div>
    <div class="insight-impact">${f.kind === 'reserve' ? '≈ ' + fmtInt(f.minutesPerDay) + ' Min Reserve pro Tag' : `≈ ${fmtInt(f.minutesPerDay)} Verspätungsminuten pro Tag`}</div>
  </article>`;
}

function reasonsCard(ins: Insights): string {
  const r = ins.reasons;
  const total = r ? Object.values(r.total).reduce((a, b) => a + b, 0) : 0;
  if (!r || total < 20) return '';
  const groups = new Map<ReasonGroup, number>();
  for (const [c, n] of Object.entries(r.total)) {
    const g = reasonGroup(+c);
    if (g) groups.set(g, (groups.get(g) ?? 0) + n);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] ?? 1;
  const colors: Record<ReasonGroup, string> = { infrastruktur: '#ff4f6e', betrieb: '#ff9a3c', fahrzeug: '#ffd447', extern: '#8b95b8', personal: '#b69cff', ausland: '#8ab4ff', fahrgaeste: '#3ee08f' };
  const top = Object.entries(r.total).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return `<section class="card">
    <h3>Was die DB als Grund meldet</h3>
    <div class="bars">${sorted
      .map(([g, n]) => `<div class="bar"><span>${REASON_GROUPS[g].label}</span><span class="num">${fmtPct(n / total, 0)}</span><div class="bar-track"><div class="bar-fill" style="width:${((n / max) * 100).toFixed(1)}%;--c:${colors[g]}"></div></div></div>`)
      .join('')}</div>
    <table class="table" style="margin-top:12px">${top.map(([c, n]) => `<tr><td>${esc(reasonText(+c))}</td><td class="num">${fmtPct(n / total, 0)}</td></tr>`).join('')}</table>
    <p class="fine">${fmtInt(total)} Verspätungsmeldungen an ${Object.keys(r.stations).length} großen Bahnhöfen (IRIS-Schnittstelle der DB, ${r.days === 1 ? '1 Tag' : `${r.days} Tage`}). ${sorted[0] ? `Größter Hebel: ${esc(REASON_GROUPS[sorted[0][0]].lever)}.` : ''}</p>
  </section>`;
}

const daysText = (n: number) => (n === 1 ? '1 Tag' : `${n} Tagen`);

export function insightsTeaser(ins: Insights | null): string {
  if (!ins) return '<p class="fine">Noch keine Echtzeitdaten gesammelt.</p>';
  const top = ins.findings.filter((f) => f.kind !== 'reserve').slice(0, 3);
  return `<p class="fine" style="margin:0 0 10px">${ins.preliminary ? 'Vorläufig: ' : ''}aus ${daysText(ins.dates.length)} echter Ist-Daten, ${fmtInt(ins.trips)} Fahrten. Belastbar wird es ab 7 Tagen.</p>
    <div class="insight-list">${top.length ? top.map(card).join('') : '<p class="fine">Noch keine auffälligen Muster.</p>'}</div>`;
}

export function insightsPage(ins: Insights): string {
  const total = ins.sources.sections + ins.sources.dwell + ins.sources.origins + ins.sources.imports || 1;
  const sources = [
    { label: 'Unterwegs zwischen Halten', v: ins.sources.sections, c: '#8b95b8' },
    { label: 'Beim Halt', v: ins.sources.dwell, c: '#ffd447' },
    { label: 'Schon beim Start', v: ins.sources.origins, c: '#b69cff' },
    { label: 'Aus dem Ausland mitgebracht', v: ins.sources.imports, c: '#8ab4ff' },
  ].sort((a, b) => b.v - a.v);
  const max = Math.max(...sources.map((s) => s.v), 1);
  const groups = GROUPS.map((g) => {
    const list = ins.findings.filter((f) => f.kind === g.kind).slice(0, 6);
    if (!list.length) return '';
    return `<section class="card"><h3>${g.title}</h3><p class="fine" style="margin:-4px 0 12px">${g.lead}</p><div class="insight-list">${list.map(card).join('')}</div></section>`;
  }).join('');
  const worstLines = ins.lines.slice(0, 8);

  return `
    <section class="hero-grade">
      <span class="eyebrow">${daysText(ins.dates.length)} · ${fmtInt(ins.trips)} Fahrten · ${fmtInt(ins.arrivals)} beobachtete Ankünfte</span>
      <div class="hero-letter" style="--c:var(--lamp);font-size:64px">${fmtPct(ins.punctuality, 0)}</div>
      <div class="hero-text">Pünktlichkeit im beobachteten Fernverkehr. Diese Erkenntnisse zeigen, wo die DB am meisten gewinnen kann.</div>
    </section>

    ${
      ins.preliminary
        ? `<div class="notice-box"><strong>Noch vorläufig.</strong> Bisher liegt erst ${daysText(ins.dates.length)} Daten vor. Ein Befund gilt als <b>belastbar</b>, wenn er auf mindestens 40 Fällen aus 7 Tagen beruht und an der Mehrzahl der Tage auftritt. So lassen sich Dauerprobleme von einmaligen Störungen unterscheiden. Bis dahin ist alles hier ein erster Hinweis.</div>`
        : ''
    }

    <section class="card">
      <h3>Wo die Verspätung entsteht</h3>
      <div class="bars">${sources
        .map((s) => `<div class="bar"><span>${s.label}</span><span class="num">${fmtPct(s.v / total, 0)}</span><div class="bar-track"><div class="bar-fill" style="width:${((s.v / max) * 100).toFixed(1)}%;--c:${s.c}"></div></div></div>`)
        .join('')}</div>
      <p class="fine">Summe der verlorenen Minuten aller beobachteten Züge. Die Hebel sind entsprechend verteilt: Fahrplan und Infrastruktur für die Strecke, Bahnsteig und Haltezeit für den Halt, Bereitstellung für den Start.</p>
    </section>

    ${reasonsCard(ins)}

    ${groups || '<section class="card"><p class="fine">Noch keine auffälligen Muster.</p></section>'}

    ${
      worstLines.length
        ? `<section class="card"><h3>Linien mit der niedrigsten Pünktlichkeit</h3><table class="table">${worstLines
            .map((l) => `<tr><td>${esc(l.line)}<span class="sub">${fmtInt(l.arrivals)} Ankünfte</span></td><td class="num">${fmtPct(l.punctuality, 0)}</td></tr>`)
            .join('')}</table></section>`
        : ''
    }

    <section class="card">
      <h3>Wie diese Erkenntnisse entstehen</h3>
      <p class="fine">Grundlage sind ausschließlich beobachtete Ist-Zeiten aus dem GTFS-Realtime-Feed von gtfs.de (DELFI). Prognosen für die Zukunft zählen nicht mit. Gemessen wird, wie viel Zeit Züge je Abschnitt, je Halt und beim Start gegenüber dem Fahrplan verlieren. Gezählt wird, wie oft geplante Umstiege platzen.</p>
      <p class="fine">Die Daten zeigen, wo und wie regelmäßig Zeit verloren geht, aber nicht warum. Ob eine Langsamfahrstelle, Güterverkehr oder Personal dahintersteckt, muss die DB mit ihren eigenen Daten prüfen. Die Maßnahmen sind deshalb als Prüfaufträge formuliert. Die Wirkung ist als verlorene Minuten pro Tag angegeben. Das ist die Obergrenze dessen, was sich an dieser Stelle gewinnen lässt.</p>
    </section>`;
}
