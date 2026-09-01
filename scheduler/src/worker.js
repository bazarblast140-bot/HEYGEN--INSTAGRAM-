// Fire the carousel on time.
//
// GitHub's own cron is best-effort and has been arriving six to eight hours
// late on this repository -- 00:37 delivered at 07:05, 12:22 at 19:08. A run
// started by the API, by contrast, begins within a few seconds. So the schedule
// moves out of GitHub and the trigger becomes an HTTP call.
//
// This Worker holds one secret and does one thing: at each cron time it tells
// the repository which post is due. The slot travels in the payload rather than
// being worked out at the other end, because the whole failure this replaces
// was a slot inferred from a clock that had moved on.
//
// Cloudflare cron triggers are UTC, like GitHub's. IST is UTC+5:30.

export const SLOTS = {
  '37 0 * * *': 'morning',    // 06:07 IST
  '37 7 * * *': 'midday',     // 13:07 IST -- technology and AI
  '37 11 * * *': 'evening',   // 17:07 IST
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
  //   curl -X POST https://<worker>/?slot=morning
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('POST ?slot=morning|midday|evening\n', { status: 405 });
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
