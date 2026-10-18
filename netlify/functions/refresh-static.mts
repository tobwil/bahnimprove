import type { Config, Context } from '@netlify/functions';

/** Startet jede Nacht den Fahrplan-Job (02:20 bzw. 03:20 Uhr, nach dem Tageswechsel um 03:00 nicht nötig). */
export default async (_req: Request, context: Context) => {
  const res = await fetch(`${context.site.url}/.netlify/functions/build-static-background`, {
    method: 'POST',
    headers: { 'x-build-secret': Netlify.env.get('STATIC_BUILD_SECRET') ?? '' },
  });
  console.log(`Fahrplan-Job gestartet: HTTP ${res.status}`);
};

export const config: Config = { schedule: '20 1 * * *' };
