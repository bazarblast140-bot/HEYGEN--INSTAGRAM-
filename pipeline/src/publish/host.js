// Put a finished file somewhere Instagram can fetch it.
//
// Instagram downloads the media from a URL and never accepts an upload, so the
// file needs a plain public HTTPS address before publishing can run. That is as
// true of a carousel's JPEGs as of a reel's MP4 — the only difference is how
// many files and what Content-Type they are uploaded under. GitHub
// Releases give exactly that, for free, with no extra account: release assets on
// a PUBLIC repository are served unauthenticated from a stable URL.
//
// Two modes:
//   default        this repository's own releases, using the Actions GITHUB_TOKEN.
//                  Requires the repository to be public — a private repo's assets
//                  need a token, which Instagram does not have.
//   MEDIA_REPO set a separate public repo (owner/name) used only as a bucket.
//                  Needs MEDIA_REPO_TOKEN, a PAT with contents:write on it.

import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

function target() {
  const repo = process.env.MEDIA_REPO || process.env.GITHUB_REPOSITORY;
  const token = process.env.MEDIA_REPO
    ? process.env.MEDIA_REPO_TOKEN
    : process.env.GITHUB_TOKEN || process.env.MEDIA_REPO_TOKEN;

  if (!repo) throw new Error('Set MEDIA_REPO (owner/name), or run inside GitHub Actions.');
  if (!token) {
    throw new Error(
      process.env.MEDIA_REPO
        ? 'MEDIA_REPO is set but MEDIA_REPO_TOKEN is missing (needs a PAT with contents:write).'
        : 'No GITHUB_TOKEN available to create the release.',
    );
  }
  return { repo, token };
}

async function gh(url, { token, method = 'GET', body, headers = {} }) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...headers,
    },
    ...(body ? { body } : {}),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${method} ${new URL(url).pathname} -> ${res.status}: ${payload.message || ''}`);
  return payload;
}

/** Reuse today's release if it exists, so repeated runs do not litter the repo. */
async function ensureRelease({ repo, token, tag }) {
  try {
    return await gh(`${API}/repos/${repo}/releases/tags/${tag}`, { token });
  } catch (err) {
    if (!String(err.message).includes('404')) throw err;
  }
  return gh(`${API}/repos/${repo}/releases`, {
    token, method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: tag, body: 'Media for a scheduled post. Created automatically.' }),
  });
}

/**
 * Content-Type is not decoration here.
 *
 * GitHub serves a release asset back with the type it was uploaded under, and
 * Instagram decides what a URL is from that header — not from the extension. A
 * JPEG uploaded as video/mp4 (which is what this file used to hardcode) is
 * fetched, found not to be a video, and rejected with a message about the media
 * being unsupported, which reads like a problem with the image.
 */
const TYPES = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext];
  if (!type) throw new Error(`No Content-Type known for "${ext}" — add it to host.js rather than guessing.`);
  return type;
}

/** Upload one file to a release and return the public URL it is served from. */
export async function hostFile({ file, tag = `media-${new Date().toISOString().slice(0, 10)}`, name = path.basename(file) }) {
  const { repo, token } = target();
  const release = await ensureRelease({ repo, token, tag });
  return upload({ repo, token, release, file, name });
}

/**
 * Upload several files under one release.
 *
 * One release rather than one per file, and one lookup rather than one per
 * upload: a 6-slide carousel is 6 assets on a single tag, so a day's post is a
 * single thing to look at or delete.
 */
export async function hostFiles({ files, tag = `carousel-${new Date().toISOString().slice(0, 10)}`, onProgress }) {
  const { repo, token } = target();
  const release = await ensureRelease({ repo, token, tag });

  const hosted = [];
  for (const [i, file] of files.entries()) {
    hosted.push(await upload({ repo, token, release, file, name: path.basename(file) }));
    onProgress?.(i + 1, files.length);
  }
  return { assets: hosted, repo, tag };
}

async function upload({ repo, token, release, file, name }) {
  // An asset name can only exist once per release; drop the old one so a re-run
  // replaces the file instead of failing.
  const existing = (release.assets || []).find((a) => a.name === name);
  if (existing) {
    await gh(`${API}/repos/${repo}/releases/assets/${existing.id}`, { token, method: 'DELETE' })
      // Already gone is the state this call wanted. The release listing is a
      // snapshot and another run may have cleared it since; refusing to upload
      // over an asset that no longer exists costs a post to protect nothing.
      .catch((err) => { if (!String(err.message).includes('404')) throw err; });
  }

  const data = fs.readFileSync(file);
  const asset = await gh(
    `${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      token, method: 'POST', body: data,
      headers: { 'Content-Type': contentTypeFor(file), 'Content-Length': String(data.length) },
    },
  );

  const url = asset.browser_download_url;
  await waitUntilServed(url);
  return { url, name, sizeBytes: data.length };
}

/**
 * Wait until the public URL actually returns the image.
 *
 * A successful upload means GitHub has the file. It does not mean the download
 * URL is serving it yet, and the gap is seconds. Instagram is handed that URL,
 * fetches it in the same breath, gets whatever stands in for the file until it
 * is ready, and answers:
 *
 *   Only photo or video can be accepted as media type. (code 9004)
 *
 * which reads as a verdict on the image and is nothing of the sort. Measured on
 * 2026-09-10 against a brand-new release: slide 1 was refused once and taken on
 * the retry four seconds later; slide 2 was refused three times over twelve
 * seconds and the post was abandoned. Same renderer, same size, same release.
 *
 * Retrying at Instagram treats the symptom and costs an API call each time. The
 * question worth asking is the one asked here, unauthenticated, exactly as
 * Instagram would ask it: is this URL serving an image yet?
 */
export async function waitUntilServed(url, { attempts = 8, waitMs = 1500, onWait } = {}) {
  let last = 'never asked';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // No Authorization header, on purpose: this has to be the fetch a stranger
      // makes, because that is the fetch Instagram makes.
      const res = await fetch(url, { redirect: 'follow' });
      const type = res.headers.get('content-type') || '';
      if (res.ok && /^(image|video)\//.test(type)) return { attempts: attempt };
      last = `${res.status} ${type || 'no content-type'}`;
    } catch (err) {
      last = err.message;
    }
    onWait?.(attempt, last);
    if (attempt < attempts) await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`${url} is still not being served after ${attempts} tries (${last}). Instagram would reject it.`);
}

export async function hostVideo({ file, tag = `reel-${new Date().toISOString().slice(0, 10)}` }) {
  const { repo, token } = target();
  const release = await ensureRelease({ repo, token, tag });
  const asset = await upload({ repo, token, release, file, name: path.basename(file) });
  return { url: asset.url, repo, tag, sizeBytes: asset.sizeBytes };
}
