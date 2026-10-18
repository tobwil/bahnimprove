export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function delayColor(d: number): string {
  if (d < 6) return '#4ade80';
  if (d < 16) return '#facc15';
  if (d < 31) return '#fb923c';
  return '#f43f5e';
}
