# On-time scheduler

GitHub's cron did not miss the morning post — it delivered it late enough that
it stopped being the morning post. Every one of the last five scheduled runs
arrived six to eight hours after its cron time:

| cron (UTC) | delivered | late by |
| --- | --- | --- |
| 00:37 | 07:05 | 6h 28m |
| 07:37 | 15:18 | 7h 41m |
| 08:22 | 16:13 | 7h 51m |
| 11:37 | 18:07 | 6h 30m |
| 12:22 | 19:08 | 6h 46m |

A run started through the API does not wait: every dispatch made while building
this pipeline began within about two seconds. So the schedule moves out of
GitHub and only the trigger stays there.

This Worker is the whole of it: three cron times, one HTTP call each, telling
the repository which post is due. The slot travels in the payload — the failure
being fixed was a slot inferred from a clock that had moved on, so nothing here
infers anything.

GitHub's own crons stay in the workflow as a backstop. If this Worker stops, a
late post still beats no post, and the ledger stops the two from doubling up.

## Setting it up

1. **A GitHub token.** github.com → Settings → Developer settings → Personal
   access tokens → **Fine-grained tokens** → Generate new token.
   - Repository access: only `HEYGEN--INSTAGRAM-`
   - Repository permissions: **Contents → Read and write** (that is what
     `repository_dispatch` needs; nothing else)
   - Expiry: the longest offered, and put a reminder in your calendar — an
     expired token stops the posts and says nothing.

2. **Deploy.** With Node installed, from this folder:

   ```
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN     # paste the token, it is never written to disk
   npx wrangler deploy
   ```

   The free Cloudflare plan covers this: three requests a day against a limit of
   a hundred thousand.

3. **Check it without waiting for 06:07.** `wrangler deploy` prints the Worker's
   URL:

   ```
   curl -X POST "https://factvizer-scheduler.<your-subdomain>.workers.dev/?slot=morning"
   ```

   `dispatched morning` means the token works and a run has started. If today's
   morning post already went out, the run will end in a few seconds saying so —
   that is the ledger doing its job, not a failure.

## Changing the times

The times live in two places that must agree: `crons` in `wrangler.toml` and
`SLOTS` in `src/worker.js`. A cron in one and not the other throws rather than
firing nothing quietly. Both are UTC; IST is UTC+5:30, so subtract 5:30.

## If you would rather not run code

cron-job.org will do the same POST from a form, with no deploying. The cost is
that your GitHub token then lives on someone else's server rather than in your
own Cloudflare account, which is why it is not the recommendation here.
