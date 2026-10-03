// Copy a just-published Instagram post to the Facebook Page.
//
//   node pipeline/fb-crosspost.js --whoami
//   node pipeline/fb-crosspost.js --kind reel     --ig-media ID --video-url URL --caption-file F
//   node pipeline/fb-crosspost.js --kind carousel --ig-media ID --hosted pipeline/out/hosted.json --caption-file F
//
// Always exits 0 for a cross-post: Facebook failing must never fail the
// Instagram run. --whoami exits 1 only when the token cannot reach a Page.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
  enabled, whoami, crossPostCarousel, crossPostReel,
  readLedger, alreadyCrossPosted, record, istDay,
} from './src/publish/facebook.js';

const { values: a } = parseArgs({
  options: {
    whoami: { type: 'boolean' }, kind: { type: 'string' }, 'ig-media': { type: 'string' },
    'video-url': { type: 'string' }, hosted: { type: 'string' }, 'caption-file': { type: 'string' },
    ledger: { type: 'string', default: 'pipeline/fb-crosspost-history.json' },
  },
});

const token = process.env.FB_PAGE_TOKEN || process.env.IG_ACCESS_TOKEN;
const pageId = process.env.FB_PAGE_ID;

async function main() {
  if (!token) { console.log('Facebook: no token, nothing done.'); return a.whoami ? 1 : 0; }

  if (a.whoami) {
    const w = await whoami({ token, pageId });
    console.log(`Facebook Page  ${w.name} (${w.id})  ·  token type ${w.type}`);
    if (!w.pageMatches) console.log(`  FB_PAGE_ID ${pageId} is not this token's Page${w.page ? ` (it is ${w.page.name})` : ''}`);
    console.log(`  scopes: ${w.scopes.join(', ') || '(unknown)'}`);
    console.log(w.missing.length ? `  MISSING for cross-posting: ${w.missing.join(', ')}` : '  scopes ok for cross-posting');
    return 0;
  }

  if (!enabled()) { console.log('FB_CROSSPOST is not true — Facebook cross-post skipped.'); return 0; }
  const igMediaId = a['ig-media'];
  if (!igMediaId) { console.log('Facebook: no Instagram media id, so nothing was published to copy.'); return 0; }
  if (alreadyCrossPosted(readLedger(a.ledger), igMediaId)) {
    console.log(`Facebook: ${igMediaId} already cross-posted — skipped.`);
    return 0;
  }
  const caption = a['caption-file'] ? fs.readFileSync(a['caption-file'], 'utf8').trim() : '';
  const target = pageId;
  try {
    let out;
    if (a.kind === 'reel') {
      out = await crossPostReel({ pageId: target, token, videoUrl: a['video-url'], caption });
    } else if (a.kind === 'carousel') {
      const hosted = JSON.parse(fs.readFileSync(a.hosted, 'utf8'));
      out = await crossPostCarousel({ pageId: target, token, imageUrls: hosted.imageUrls, caption });
    } else {
      console.log(`Facebook: unknown --kind ${a.kind}`); return 0;
    }
    record(a.ledger, { date: istDay(), kind: a.kind, igMediaId, fbId: out.id });
    console.log(`Facebook cross-post published ${out.id} ${out.url}`);
  } catch (err) {
    console.log(`Facebook cross-post FAILED (Instagram unaffected): ${String(err.message).slice(0, 300)}`);
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.log(`Facebook: ${String(err.message).slice(0, 300)}`);
  process.exit(a.whoami ? 1 : 0);
});
