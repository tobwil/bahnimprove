/**
 * Vorschaukarte für geteilte Zugfahrten im Pixel-Look (1200×632 PNG für Messenger-Vorschauen).
 * Gezeichnet wird in 300×158 Pixeln mit der Kartenschrift und dann vierfach vergrößert.
 */
import { DELAY_COLORS, px } from '../ui/map.ts';
import { drawText, textWidth } from '../ui/font.ts';
import { hhmm } from '../sim/text.ts';
import { isPain, type FollowStatus } from './status.ts';

export const CARD_W = 300;
export const CARD_H = 158;
export const CARD_SCALE = 4;

const C = {
  bg: px('#070a14'),
  panel: px('#131a30'),
  line: px('#2a3557'),
  text: px('#e9eefc'),
  muted: px('#8b95b8'),
  dim: px('#5d6789'),
  lamp: px('#ffc56b'),
  live: px('#ff4f6e'),
  ok: px('#3ee08f'),
  badge: px('#e9eefc'),
  badgeText: px('#0c1121'),
};

const delayPx = (d: number) => px(DELAY_COLORS.find((c) => d < c.max)!.color);

function rect(buf: Uint32Array, x: number, y: number, w: number, h: number, c: number) {
  for (let j = Math.max(0, y); j < Math.min(CARD_H, y + h); j++) for (let i = Math.max(0, x); i < Math.min(CARD_W, x + w); i++) buf[j * CARD_W + i] = c;
}

/** Text in ganzzahliger Vergrößerung */
function text(buf: Uint32Array, x: number, y: number, s: string, color: number, scale = 1) {
  if (scale === 1) return drawText(buf, CARD_W, CARD_H, x, y, s, color);
  const tw = textWidth(s) + 1, th = 6;
  const tmp = new Uint32Array(tw * th);
  drawText(tmp, tw, th, 0, 0, s, 1);
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) if (tmp[j * tw + i]) rect(buf, x + i * scale, y + j * scale, scale, scale, color);
}

/** Kürzt auf die Breite (in Kartenpixeln) */
function fit(s: string, maxW: number, scale: number): string {
  let out = s;
  while (out.length > 1 && textWidth(out) * scale > maxW) out = out.slice(0, -1);
  return out === s ? s : `${out.slice(0, -1).trimEnd()}.`;
}

export function renderCard(st: FollowStatus, opts: { name?: string; stamp: number }): Uint32Array {
  const buf = new Uint32Array(CARD_W * CARD_H).fill(C.bg);
  // Kopf: "SHARE MY TRAIN" – bei großer Verspätung "SHARE MY T̶R̶A̶I̶N̶ PAIN"
  const pain = isPain(st.delay, st.state === 'canceled');
  let bx = 10;
  text(buf, bx, 5, 'SHARE MY', C.muted, 2);
  bx += (textWidth('SHARE MY ') + 1) * 2;
  text(buf, bx, 5, 'TRAIN', pain ? C.dim : C.lamp, 2);
  if (pain) {
    rect(buf, bx - 2, 9, (textWidth('TRAIN') + 2) * 2, 2, C.live);
    text(buf, bx + (textWidth('TRAIN ') + 1) * 2, 5, 'PAIN', C.live, 2);
  }
  const live = 'LIVE';
  rect(buf, CARD_W - 10 - textWidth(live) * 2 - 8, 7, 4, 6, C.live);
  text(buf, CARD_W - 10 - textWidth(live) * 2, 5, live, C.muted, 2);
  rect(buf, 10, 19, CARD_W - 20, 1, C.line);

  // Linie und Verspätung groß
  const lineW = textWidth(st.line) * 4;
  rect(buf, 10, 26, lineW + 10, 28, C.badge);
  text(buf, 15, 30, st.line, C.badgeText, 4);
  const late = st.state === 'canceled' ? 'AUSFALL' : st.known ? (st.delay >= 1 ? `+${st.delay}` : 'PÜNKTLICH') : '';
  if (late) {
    const c = st.state === 'canceled' ? C.live : delayPx(st.delay);
    const sc = textWidth(late) * 4 > CARD_W - lineW - 40 ? 2 : 4;
    text(buf, CARD_W - 10 - textWidth(late) * sc, 30 + (4 - sc) * 2, late, c, sc);
  }

  // Wer, wohin, wann
  const who = opts.name ? `${opts.name} ` : '';
  const head = st.state === 'arrived' ? `${who}IST IN ${st.target} ANGEKOMMEN` : `${who}REIST NACH ${st.target}`;
  text(buf, 10, 64, fit(head, CARD_W - 20, 2), C.text, 2);
  const when =
    st.state === 'canceled' ? 'ZUG FÄLLT AUS' : st.state === 'arrived' ? `ANKUNFT ${hhmm(st.estArr)}` : `ANKUNFT ${hhmm(st.estArr)}${st.delay >= 1 ? ` STATT ${hhmm(st.schedArr)}` : ''}`;
  text(buf, 10, 82, fit(when, CARD_W - 20, 2), st.delay >= 6 ? delayPx(st.delay) : C.lamp, 2);

  // Fortschritt bis zum Ausstieg
  const x0 = 14, x1 = CARD_W - 14, y = 106;
  rect(buf, x0, y, x1 - x0, 2, C.line);
  const px0 = Math.round(x0 + (x1 - x0) * st.progress);
  rect(buf, x0, y, px0 - x0, 2, C.lamp);
  rect(buf, x0 - 2, y - 2, 5, 6, C.lamp);
  rect(buf, x1 - 2, y - 3, 5, 8, C.text);
  rect(buf, px0 - 3, y - 3, 7, 8, C.bg);
  rect(buf, px0 - 2, y - 2, 5, 6, st.known ? delayPx(st.delay) : C.muted);
  text(buf, x0 - 2, y + 7, fit(st.board, 120, 1), C.dim);
  text(buf, x1 + 2 - textWidth(st.target), y + 7, st.target, C.muted);

  // Wo gerade
  const now = textWidth(`JETZT: ${st.where}`) * 2 <= CARD_W - 20 ? `JETZT: ${st.where}` : st.where;
  text(buf, 10, 126, fit(now, CARD_W - 20, 2), C.muted, 2);
  const kg = Math.round(st.co2Kg);
  if (kg >= 1) {
    // Platz bis zur Adresse rechts; beim Pain-Spruch fällt sonst zuerst die kg-Angabe weg
    const room = CARD_W - 20 - textWidth('SHAREMYTRAIN.DE') - 6;
    const long = pain ? `PAIN IS TEMPORARY - CO2 REDUCTION IS FOREVER (${kg} KG)` : `${kg} KG CO2 WENIGER ALS MIT DEM AUTO`;
    const co2 = textWidth(long) <= room || !pain ? long : 'PAIN IS TEMPORARY - CO2 REDUCTION IS FOREVER';
    text(buf, 10, CARD_H - 11, fit(co2, room, 1), C.ok);
  } else text(buf, 10, CARD_H - 11, `STAND ${hhmm(opts.stamp)} - LINK ZEIGT DIE FAHRT LIVE`, C.dim);
  text(buf, CARD_W - 10 - textWidth('SHAREMYTRAIN.DE'), CARD_H - 11, 'SHAREMYTRAIN.DE', C.lamp);
  return buf;
}

/** Pixelpuffer (ABGR) vergrößert als RGBA-Bytes */
export function upscale(buf: Uint32Array, w: number, h: number, k: number): Uint8Array {
  const out = new Uint32Array(w * k * h * k);
  for (let y = 0; y < h * k; y++) {
    const row = ((y / k) | 0) * w;
    for (let x = 0; x < w * k; x++) out[y * w * k + x] = buf[row + ((x / k) | 0)];
  }
  return new Uint8Array(out.buffer);
}
