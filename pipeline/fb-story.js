#!/usr/bin/env node
// Facebook Page photo Story for each carousel Story frame the publish step
// posted to Instagram (pipeline/out/stories.json). See src/publish/fb-story.js.
//
//   node pipeline/fb-story.js --stories pipeline/out/stories.json
//
// Off unless FB_CROSSPOST=true (FB_PAGE_ID + FB_PAGE_TOKEN). Always exits 0:
// a Facebook Story can never fail the job or undo anything already posted.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { fbStory, FB_STORY_LEDGER } from './src/publish/fb-story.js';

export async function postCarouselStories({ storiesFile, env = process.env, file = FB_STORY_LEDGER, fetchImpl = fetch, log = (l) => console.log(l), now = Date.now() } = {}) {
  let note;
  try { note = JSON.parse(fs.readFileSync(storiesFile, 'utf8')); } catch {
    log('Facebook Story: no Instagram Story was posted in this run — nothing to copy.');
    return [];
  }
  const results = [];
  for (const s of note.stories || []) {
    results.push(await fbStory({
      kind: 'photo', igStoryId: s.igStoryId, igMediaId: note.igMediaId, url: s.imageUrl, source: 'carousel', env, file, fetchImpl, log, now,
    }));
  }
  if (!results.length) log('Facebook Story: no Instagram Story was posted in this run — nothing to copy.');
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: a } = parseArgs({ options: { stories: { type: 'string', default: 'pipeline/out/stories.json' } } });
  postCarouselStories({ storiesFile: a.stories })
    .catch((err) => console.log(`Facebook Story error (ignored): ${String(err?.message || err).replace(/access_token=[^&\s]+/g, 'access_token=***').slice(0, 300)}`))
    .finally(() => process.exit(0));
}
