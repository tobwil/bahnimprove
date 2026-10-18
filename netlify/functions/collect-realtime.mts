import type { Config } from '@netlify/functions';
import { collect } from './shared.mts';

/** Sammelt alle 2 Minuten die Echtzeitdaten, damit der ganze Tag (auch für den Tagesbericht) vorliegt. */
export default async () => {
  const days = await collect();
  console.log(days.map((d) => `${d.date}: ${Object.keys(d.trips).length} Fahrten`).join(', '));
};

export const config: Config = { schedule: '*/2 * * * *' };
