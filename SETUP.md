# Setup — five steps, then it runs itself

Do these once. Everything after is automatic at 7:00 AM IST on weekdays.

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
| `PEXELS_API_KEY` | pexels.com/api — free |
| `PIXABAY_API_KEY` | pixabay.com/api/docs — free |

**Variables** (visible, not secret — copy these exactly):

| Name | Value |
| --- | --- |
| `HEYGEN_AVATAR_ID` | `976292674ea5406591a36443e2feb17f` |
| `HEYGEN_VOICE_ID` | `a1b2ea9b4b3c443fb3b87d32c9794516` |
| `IG_USER_ID` | `17841410293109609` |
| `IG_SURFACE` | `facebook` |
| `FB_APP_ID` | `1690836568687131` |
| `FB_PAGE_ID` | `691172017411768` |

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
