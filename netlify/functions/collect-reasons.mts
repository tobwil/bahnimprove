import type { Config } from '@netlify/functions';
import { collectReasons } from '../realtime-store.mts';

/** Alle 10 Minuten: Verspätungsgründe der wichtigsten Bahnhöfe aus der IRIS-Schnittstelle der DB. */
export default async () => {
  const r = await collectReasons();
  console.log(`Gründe ${r.date}: ${r.added} neue Meldungen, ${r.failed} Bahnhöfe nicht erreichbar`);
};

export const config: Config = { schedule: '*/10 * * * *' };
