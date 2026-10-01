# On-time scheduler

GitHub's cron often arrives six to ten hours late. A run started through the
API does not wait, so the two daily posts are fired from this Worker and
GitHub's own crons stay in the workflow only as a backstop. The ledger
(`YYYY-MM-DD <slot>`, IST) stops the two from doubling up.

Two finance carousels:

| cron (UTC) | IST | post |
| --- | --- | --- |
| `0 7 * * *` | 12:30 | optional finance carousel |
| `0 14 * * *` | 19:30 | main finance carousel, plus one Story |

AI news and the general-news digest are off. Stories go out only with the
19:30 post, and only one frame.

The slot travels in the `repository_dispatch` payload. The pipeline also
derives a slot from the IST clock when a run arrives with no slot, and it
skips anything outside 12:00–13:45 and 19:00–20:45 IST. A GitHub `schedule`
event keeps the slot written on its cron even when that cron is hours late.

## What to change outside this repo

The Worker that is already deployed does not pick up a git push. Until it is
redeployed it keeps firing `37 0`, `37 7` and `37 11` (06:07, 13:07 and 17:07
IST). Those runs have been showing up as `workflow_dispatch` with no slot,
and the old default then posted the evening carousel at about 06:09 IST.

After this change a run with no slot publishes only inside the two windows
above, so 06:07 and 17:07 no longer post. 13:07 still falls inside the
optional midday window, so it will keep posting until the trigger moves.

1. Redeploy this Worker (`npx wrangler deploy` from `scheduler/`, or paste
   `src/worker.js` into the Cloudflare editor and deploy).
2. In the Worker → Settings → Triggers, delete `37 0 * * *`, `37 7 * * *`
   and `37 11 * * *`. Leave only:

   ```
   0 7 * * *       12:30 IST
   0 14 * * *      19:30 IST
   ```

3. If cron-job.org or any other caller starts **Build carousel** with
   `workflow_dispatch` at 06:07, 13:07 or 17:07, disable it or point it at
   12:30 and 19:30 IST. A dispatch with no slot now posts only inside the
   two windows. Do not send `slot=evening` at 06:07: that is refused as the
   wrong time.

## Setting it up — browser only, no CLI

1. **A GitHub token.** github.com → Settings → Developer settings → Personal
   access tokens → **Fine-grained tokens** → generate one.
   - Repository access: only `HEYGEN--INSTAGRAM-`
   - Repository permissions: **Contents → Read and write**, nothing else. That
     is what `repository_dispatch` needs.
   - Expiry: the longest offered, and put a reminder in your calendar.
   - Copy it once. Do not paste it into a chat.

2. **A Worker.** dash.cloudflare.com → Workers & Pages → create a Worker.
   Open its editor, delete the placeholder, and paste all of
   `scheduler/src/worker.js` from this repo. Save and deploy.

3. **Its two settings.** In the Worker's Settings → Variables:
   - a plain variable `REPO` = `bazarblast140-bot/HEYGEN--INSTAGRAM-`
   - a **secret** `GITHUB_TOKEN` = the token

4. **Its two times.** Settings → Triggers → Cron Triggers. UTC, like GitHub's.

   ```
   0 7 * * *       12:30 IST -- optional finance carousel
   0 14 * * *      19:30 IST -- main finance carousel
   ```

5. **Check it.** POST to the Worker URL:

   ```
   curl -X POST "https://<your-worker>.workers.dev/?slot=evening"
   ```

   `dispatched evening` means the token works. If that slot already went out
   today, the run ends in a few seconds saying so.

## Setting it up — from a terminal instead

From this folder:

```
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

Then:

```
curl -X POST "https://factvizer-scheduler.<your-subdomain>.workers.dev/?slot=evening"
```

## Changing the times

The times live in two places that must agree: `crons` in `wrangler.toml` and
`SLOTS` in `src/worker.js`. A cron in one and not the other throws rather than
firing nothing quietly. Both are UTC; IST is UTC+5:30, so subtract 5 hours
30 minutes. The posting windows in `pipeline/src/carousel/categories.js` have
to cover the new times as well.

## If you would rather not run code

cron-job.org will do the same POST from a form. The GitHub token then lives
on someone else's server, which is why it is not the recommendation here.
If you use it, schedule 12:30 and 19:30 IST only, and send the slot.
