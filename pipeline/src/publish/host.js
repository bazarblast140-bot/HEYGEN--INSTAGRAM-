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
  if (existing) await gh(`${API}/repos/${repo}/releases/assets/${existing.id}`, { token, method: 'DELETE' });

  const data = fs.readFileSync(file);
  const asset = await gh(
    `${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      token, method: 'POST', body: data,
      headers: { 'Content-Type': contentTypeFor(file), 'Content-Length': String(data.length) },
    },
  );

  return { url: asset.browser_download_url, name, sizeBytes: data.length };
}

export async function hostVideo({ file, tag = `reel-${new Date().toISOString().slice(0, 10)}` }) {
  const { repo, token } = target();
  const release = await ensureRelease({ repo, token, tag });
  const asset = await upload({ repo, token, release, file, name: path.basename(file) });
  return { url: asset.url, repo, tag, sizeBytes: asset.sizeBytes };
}
