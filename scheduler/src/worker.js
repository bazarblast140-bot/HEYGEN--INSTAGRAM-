// Fire the carousel on time.
//
// GitHub's own cron is best-effort and has been arriving six to ten hours
// late. A run started by the API begins within a few seconds, so the schedule
// lives here and the trigger is an HTTP call.
//
// Two finance posts: optional midday at 12:30 IST, main evening at 19:30 IST.
// AI news and the general-news digest are off. The slot still travels in the
// payload. The pipeline also refuses a dispatch that arrives outside that
// slot's window, so an old cron cannot publish at 06:07 or 17:07.
//
// Cloudflare cron triggers are UTC, like GitHub's. IST is UTC+5:30.
// Redeploy after changing these (`npx wrangler deploy` from scheduler/).
// A copy already running in Cloudflare keeps the old times until you do.

export const SLOTS = {
  '0 7 * * *': 'midday',    // 12:30 IST
  '0 14 * * *': 'evening',  // 19:30 IST
};

export async function dispatch({ repo, token, slot }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects an API call with no User-Agent, and the rejection reads
      // like an auth failure.
      'User-Agent': 'factvizer-scheduler',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'carousel', client_payload: { slot } }),
  });

  // 204 No Content is success here; anything else is worth seeing in the log.
  if (!res.ok) {
    throw new Error(`GitHub refused the ${slot} dispatch: ${res.status} ${await res.text()}`);
  }
  return res.status;
}

export default {
  async scheduled(event, env) {
    const slot = SLOTS[event.cron];
    if (!slot) {
      // A cron added here and not to the table would otherwise fire nothing at
      // all, silently.
      throw new Error(`No slot mapped for cron "${event.cron}"`);
    }
    await dispatch({ repo: env.REPO, token: env.GITHUB_TOKEN, slot });
    console.log(`dispatched ${slot}`);
  },

  // Same job, on demand, for checking the token without waiting for a cron.
  //   curl -X POST https://<worker>/?slot=evening
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('POST ?slot=midday|evening\n', { status: 405 });
    const slot = new URL(request.url).searchParams.get('slot');
    if (!Object.values(SLOTS).includes(slot)) return new Response('unknown slot\n', { status: 400 });

    try {
      await dispatch({ repo: env.REPO, token: env.GITHUB_TOKEN, slot });
      return new Response(`dispatched ${slot}\n`);
    } catch (err) {
      return new Response(`${err.message}\n`, { status: 502 });
    }
  },
};
