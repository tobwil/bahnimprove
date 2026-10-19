/** Winzige 3×5-Pixelschrift (nur Großbuchstaben) für Beschriftungen direkt auf der Pixelkarte. */
const GLYPHS: Record<string, string> = {
  A: '.#.|#.#|###|#.#|#.#', B: '##.|#.#|##.|#.#|##.', C: '.##|#..|#..|#..|.##', D: '##.|#.#|#.#|#.#|##.',
  E: '###|#..|##.|#..|###', F: '###|#..|##.|#..|#..', G: '.##|#..|#.#|#.#|.##', H: '#.#|#.#|###|#.#|#.#',
  I: '###|.#.|.#.|.#.|###', J: '..#|..#|..#|#.#|.#.', K: '#.#|#.#|##.|#.#|#.#', L: '#..|#..|#..|#..|###',
  M: '#...#|##.##|#.#.#|#...#|#...#', N: '#..#|##.#|#.##|#..#|#..#', O: '.#.|#.#|#.#|#.#|.#.', P: '##.|#.#|##.|#..|#..',
  Q: '.#.|#.#|#.#|##.|.##', R: '##.|#.#|##.|#.#|#.#', S: '.##|#..|.#.|..#|##.', T: '###|.#.|.#.|.#.|.#.',
  U: '#.#|#.#|#.#|#.#|###', V: '#.#|#.#|#.#|#.#|.#.', W: '#...#|#...#|#.#.#|##.##|#...#', X: '#.#|#.#|.#.|#.#|#.#',
  Y: '#.#|#.#|.#.|.#.|.#.', Z: '###|..#|.#.|#..|###', Ä: '#.#|...|.#.|###|#.#', Ö: '#.#|...|###|#.#|###',
  Ü: '#.#|...|#.#|#.#|###', '0': '###|#.#|#.#|#.#|###', '1': '.#.|##.|.#.|.#.|###', '2': '##.|..#|.#.|#..|###',
  '3': '##.|..#|.#.|..#|##.', '4': '#.#|#.#|###|..#|..#', '5': '###|#..|##.|..#|##.', '6': '.##|#..|###|#.#|###',
  '7': '###|..#|.#.|.#.|.#.', '8': '###|#.#|###|#.#|###', '9': '###|#.#|###|..#|##.', '-': '...|...|###|...|...',
  '.': '...|...|...|...|.#.', ':': '...|.#.|...|.#.|...', '(': '.#.|#..|#..|#..|.#.', ')': '.#.|..#|..#|..#|.#.',
  '/': '..#|..#|.#.|#..|#..', '+': '...|.#.|###|.#.|...', ' ': '...|...|...|...|...', "'": '.#.|.#.|...|...|...',
};

/** Glyphen als Pixelzeilen; Breite je Zeichen variabel (M, N, W sind breiter). */
const ROWS = new Map<string, string[]>(Object.entries(GLYPHS).map(([ch, s]) => [ch, s.split('|')]));

export const GLYPH_H = 5;

export function normalizeText(s: string): string {
  return s.toUpperCase().replace(/ß/g, 'SS').replace(/[ÈÉÊ]/g, 'E').replace(/[ÀÁÂ]/g, 'A');
}

const glyph = (ch: string) => ROWS.get(ch) ?? ROWS.get(' ')!;

export const textWidth = (s: string) => {
  const chars = [...normalizeText(s)];
  return Math.max(0, chars.reduce((w, ch) => w + glyph(ch)[0].length + 1, 0) - 1);
};

/** Schreibt Text in einen 32-Bit-Pixelpuffer (ABGR, wie ImageData auf Little-Endian). */
export function drawText(buf: Uint32Array, w: number, h: number, x: number, y: number, text: string, color: number, shadow?: number) {
  const s = [...normalizeText(text)];
  const put = (px: number, py: number, c: number) => {
    if (px >= 0 && py >= 0 && px < w && py < h) buf[py * w + px] = c;
  };
  for (const pass of shadow === undefined ? [0] : [1, 0]) {
    let cx = x;
    for (const ch of s) {
      const rows = glyph(ch);
      rows.forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) {
          if (row[gx] !== '#') continue;
          const px = cx + gx, py = y + gy;
          if (pass === 1) {
            put(px + 1, py, shadow!);
            put(px, py + 1, shadow!);
            put(px + 1, py + 1, shadow!);
            put(px - 1, py, shadow!);
            put(px, py - 1, shadow!);
          } else put(px, py, color);
        }
      });
      cx += rows[0].length + 1;
    }
  }
}
