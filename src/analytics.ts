/**
 * Reichweitenmessung mit Umami: ohne Cookies und ohne Speicherung auf dem Gerät.
 * Ereignisse tragen nur grobe Merkmale (Tab, Zuggattung, Art der Suche) – keine Namen,
 * Suchtexte oder Standorte. Das Skript lädt verzögert; frühe Ereignisse warten kurz.
 */
type Data = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: { track(event: string, data?: Data): void };
  }
}

const queue: [string, Data | undefined][] = [];
let tries = 0;

function flush() {
  if (window.umami) {
    for (const [event, data] of queue.splice(0)) {
      try {
        window.umami.track(event, data);
      } catch {
        // Statistik darf die App nie stören
      }
    }
  } else if (queue.length && tries++ < 20) setTimeout(flush, 500);
}

export function track(event: string, data?: Data) {
  queue.push([event, data]);
  flush();
}

/** Widerspruch gegen die Statistik: Umami prüft diesen Schlüssel selbst und sendet dann nichts. */
const OPT_OUT = 'umami.disabled';
export function trackingDisabled(): boolean {
  try {
    return !!localStorage.getItem(OPT_OUT);
  } catch {
    return false;
  }
}
export function setTrackingDisabled(off: boolean) {
  try {
    if (off) localStorage.setItem(OPT_OUT, '1');
    else localStorage.removeItem(OPT_OUT);
  } catch {
    // ohne Speicher kein dauerhafter Widerspruch möglich
  }
}
