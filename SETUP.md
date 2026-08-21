# Setup — one purchase, five steps, then it runs itself

Do these once. Everything after is automatic at 7:00 AM IST on weekdays.

---

## 0. The HeyGen plan — read this first

The account is on the **free** plan, and that is currently the one thing stopping
the reel from sounding like you. Measured against the live account, not guessed:

| What the reel needs | Endpoint | Free plan |
|---|---|---|
| Your face | `/v2/video/generate` | monthly avatar allowance **exhausted** |
| Your voice | `/v1/tts.generate` | **403 forbidden** — API keys are not entitled |
| Voices, avatars, quota | `/v2/voices`, `/v2/avatars` | fine |

All three avatar engines refuse, each in its own words:

```
avatar_iii  MOVIO_PAYMENT_INSUFFICIENT_CREDIT        needs a paid plan
avatar_iv   AVATAR_IV_..._DURATION_LIMIT_REACHED     monthly cap, used up
avatar_v    AVATAR_IV_..._DURATION_LIMIT_REACHED     same cap
```

The quota block reports `tts_free_credit: 572`, which looks like plenty of voice
left — but those credits are spendable from the HeyGen web app, not from an API
key. That is what the 403 means: right path, wrong entitlement.

**The voice no longer waits for this.** Synthesis moved to ElevenLabs, which the
API key does reach, so the reel is narrated in Rajesh's cloned voice on the free
HeyGen plan. A paid HeyGen plan now buys only the *face* — the few seconds of
avatar on screen — which is the least urgent part.

What does still block posting is market data. No keyless source reaches a CI
runner: Stooq answers HTML to every URL variant on both hosts, and Yahoo answers
429 on both. Set `TWELVEDATA_API_KEY` or `ALPHAVANTAGE_API_KEY` (either, both
free) and the reel becomes publishable. Until then it builds every morning and
marks itself not publishable rather than narrating invented numbers.

Run **Actions → HeyGen doctor → Run workflow** any time to re-check. It spends no
credits and prints no secrets, and it will say plainly which of these have
cleared.

---

## 1. Make this repository public

**Settings → General → scroll to the bottom → Change visibility → Public**

Instagram downloads the video from a public link — it never accepts an upload.
Release assets on a private repo need a password, so Instagram cannot fetch them.
Public makes this free and automatic with nothing else to set up.

Nothing secret lives in the repo. Every credential sits in Secrets, which stay
private even on a public repository.

*Prefer to keep it private?* Make a second public repo, put its `owner/name` in the
variable `MEDIA_REPO`, and add a personal access token with `contents:write` as the
secret `MEDIA_REPO_TOKEN`. Everything else is the same.

## 2. Nothing to do — already done

Scheduled workflows only run from the default branch, and the **Run workflow**
button only appears for workflows on it.

This repository has a single branch, `claude/heygen-avatar-new-project-x7kfed`,
and GitHub made it the default when it was first pushed. There is no `main` to
merge into, and nothing to merge — the workflows are already where they need to be.

Rename it to `main` later if you like: **Settings → Branches → pencil icon**. The
workflows keep running either way.

## 3. Add the secrets and variables

**Settings → Secrets and variables → Actions**

**Secrets** (hidden, never shown again):

| Name | Where it comes from |
| --- | --- |
| `HEYGEN_API_KEY` | HeyGen → Settings → API |
| `FB_APP_SECRET` | Meta app → Settings → Basic → Show |
| `IG_ACCESS_TOKEN` | filled in by step 4 |
| `ELEVENLABS_API_KEY` | elevenlabs.io → Settings → API Keys |
| `TWELVEDATA_API_KEY` | twelvedata.com — free (or use Alpha Vantage) |
| `ALPHAVANTAGE_API_KEY` | alphavantage.co — free (or use Twelve Data) |
| `PEXELS_API_KEY` | pexels.com/api — free |
| `PIXABAY_API_KEY` | pixabay.com/api/docs — free |

**Variables** (visible, not secret — copy these exactly):

| Name | Value |
| --- | --- |
| `IG_USER_ID` | `17841410293109609` |
| `IG_SURFACE` | `facebook` |
| `FB_APP_ID` | `1690836568687131` |
| `FB_PAGE_ID` | `691172017411768` |

The four `HEYGEN_*` variables are gone from this list on purpose. They are now
defaults in `src/config.js`, verified against the live account, because a
variable pasted with a trailing newline already cost one morning's reel its face
— HeyGen reported "avatar look not found" and blamed the id rather than the
invisible character after it. Set them only if the avatar or voice ever changes;
an environment value still wins over the default.

## 4. Turn your token into one that lasts

The token from the Graph API Explorer dies in an hour or two. A daily poster built
on it works once, then fails every morning after.

**Actions → Set up Instagram token → Run workflow** → paste the short-lived token → Run.

When it finishes, download the **instagram-token** artifact, open the file, and paste
the line into the secret `IG_ACCESS_TOKEN`. Then delete the downloaded file.

The result is a Page token, which does not expire — so this is a one-time job.
The token is handed over as a private artifact rather than printed, because
workflow logs are not a safe place for a credential.

## 5. Run it

**Actions → Build reel → Run workflow**

Leave *publish* off for the first run. You get the finished MP4 as an artifact, so
you can watch it before anything reaches your audience. Happy with it? Run again
with *publish* on.

After that the schedule takes over: weekdays, 7:00 AM IST.

---

## If something goes wrong

Every run writes `run-report.json` into the artifact. It lists exactly what
happened, including anything that fell back:

- HeyGen out of credits → the avatar beat becomes a full-frame card, TTS speaks the line
- Voiceover unavailable → silence, and the reel is marked not publishable
- Stock footage unavailable → that beat is dropped
- Live market data unavailable → sample data, and the reel is marked not publishable

`publishable` is `true` only with real market data and a real voiceover, and the
publish step refuses anything else. A broken reel cannot reach your feed.

---

## One more secret, for the daily script

Without a script model the pipeline still runs, but it falls back to the checked-in
spec — which means **the same reel every morning**. With one, each day's brief is
written from that day's actual numbers.

Add whichever you have as a repository **secret**. The first one found is used:

| Secret | Vendor | Default model |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude | `claude-fable-5` |
| `MOONSHOT_API_KEY` | Moonshot / Kimi | `kimi-k2-0711-preview` |
| `DEEPSEEK_API_KEY` | DeepSeek | `deepseek-chat` |
| `GROQ_API_KEY` | Groq | `llama-3.3-70b-versatile` |
| `OPENROUTER_API_KEY` | OpenRouter | `deepseek/deepseek-chat` |
| `TOGETHER_API_KEY` | Together | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |

**To use a specific model** — e.g. DeepSeek v4 Flash — add the repository
**variable** `SCRIPT_MODEL` with that model's exact id. It overrides the default
above. If the id is wrong, the run says so by name instead of failing vaguely.

**Any other vendor** that speaks the OpenAI chat-completions API: set the variables
`SCRIPT_BASE_URL` and `SCRIPT_MODEL`, and the secret `SCRIPT_API_KEY`. No code
change needed.
