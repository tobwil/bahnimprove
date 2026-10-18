import type { Config } from '@netlify/functions';
import { buildMissingAggregates } from '../realtime-store.mts';

/** Verdichtet abgeschlossene Verkehrstage für die Lessons learned. */
export default async () => {
  const built = await buildMissingAggregates();
  console.log(built.length ? `Verdichtet: ${built.join(', ')}` : 'Nichts zu tun');
};

// 02:15 UTC = 03:15 Uhr (Winterzeit) bzw. 04:15 Uhr (Sommerzeit) – nach Ende des Verkehrstags um 03:00.
export const config: Config = { schedule: '15 2 * * *' };
