// Midday real-source carousel: pick checks and workflow gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { parseItems, istDateOf, pickProblems, DROP, KINDS } from '../pipeline/realsource/pick.mjs';

test('RSS items: dates in IST (with or without an offset)', () => {
  const xml = '<rss><item><title><![CDATA[Nifty ends higher]]></title><link>https://x/a</link><pubDate>Wed, 14 Oct 2026 17:49</pubDate></item><item><title>B</title><link>https://x/b</link><pubDate>Tue, 13 Oct 2026 20:00:00 +0000</pubDate></item></rss>';
  const items = parseItems(xml);
  assert.equal(items[0].title, 'Nifty ends higher');
  assert.equal(istDateOf(items[0].pubDate), '2026-10-14');
  assert.equal(istDateOf(items[1].pubDate), '2026-10-14'); // 20:00 UTC = 01:30 IST next day
});

test('stock tips and live blogs never become candidates', () => {
  for (const t of ['Top 2 stocks to buy for short-term', 'Buy or sell: Sumeet Bagadia', 'Stock market today LIVE updates']) assert.match(t, DROP);
  assert.doesNotMatch('Tata Technologies Q2: Profit declines 5%', DROP);
});

const cands = [0, 1, 2, 3].map((i) => ({ headline: `H${i}`, text: `Profit rose 15% to ₹1,200 crore in Q2 number ${i}. Exit load is 2%.` }));
const good = () => ({
  hook: 'Profit बढ़ा, अच्छी ख़बर',
  hookFrom: 0, hookTerms: ['Profit'],
  articles: KINDS.map((k, i) => ({ cand: i, kicker: k, key: `Profit rose 15% to ₹1,200 crore in Q2 number ${i}.`, title: 'Profit बढ़ा', coverLine: 'Profit 15% ऊपर', plain: 'Profit 15% बढ़कर ₹1,200 crore हुआ.', summary: 'Profit 15% ऊपर (Mint).', captionLine: 'Profit 15% upar', contains: ['15%', '₹1,200 crore'] })),
});

test('a pick that only uses the visible text passes', () => assert.deepEqual(pickProblems(good(), cands), []));

test('invented numbers, paraphrased keys, missing kinds and digits in the hook are refused', () => {
  const p = good(); p.articles[0].plain = 'Profit 18% बढ़ा.'; assert.match(pickProblems(p, cands).join(), /number 18 in plain/);
  const q = good(); q.articles[1].key = 'Profit went up 15 percent to 1,200 crore.'; assert.match(pickProblems(q, cands).join(), /not copied verbatim/);
  const r = good(); r.articles[3].kicker = 'Market'; assert.match(pickProblems(r, cands).join(), /one article per kind/);
  const s = good(); s.hook = 'Nifty 1% ऊपर'; assert.match(pickProblems(s, cands).join(), /hook must not contain numbers/);
  const t = good(); t.articles[2].cand = 0; assert.match(pickProblems(t, cands).join(), /4 different candidates/);
});

test('midday-realsource.yml: publish off by default, claim before post, every frame as a Story', async () => {
  const wf = await fs.readFile(new URL('../.github/workflows/midday-realsource.yml', import.meta.url), 'utf8');
  assert.match(wf, /PUBLISH_ON: \$\{\{ vars\.MIDDAY_REALSOURCE_PUBLISH \}\}/);
  assert.match(wf, /if \[ "\$PUBLISH_ON" = true \]; then MODE=publish/);
  assert.match(wf, /default: check/);
  assert.match(wf, /group: carousel-oneoff/);
  const claim = wf.indexOf("Claim today's midday"); const pub = wf.indexOf('Publish to Instagram');
  assert.ok(claim > 0 && pub > claim, 'claim comes before publish');
  assert.match(wf, /oneoff-evening\.js --slot midday --pkg "\$PKG" --mode "\$\{\{ steps\.mode\.outputs\.mode \}\}"/);
  assert.match(wf, /publish-carousel\.js .*--max-stories 10 --yes/);
  assert.match(wf, /fb-story\.js --stories/);
  assert.match(wf, /cron: '0 7 \* \* 1-5'/);
  assert.ok((wf.match(/- cron:/g) || []).length >= 3, 'fallback crons inside the window');
  assert.doesNotMatch(wf, /\$\{\{\s*inputs\.(sha|mode|from_run)\s*\}\}"/, 'inputs reach the shell through env');
});

test('the source name CNBC-TV18 is not read as a number', () => {
  const p = good(); p.articles[0].summary = 'Profit 15% ऊपर (CNBC-TV18).';
  assert.deepEqual(pickProblems(p, cands), []);
});

test('curly quotes and line breaks do not break a verbatim key', () => {
  const c2 = cands.map((c) => ({ ...c, text: c.text.replace('rose 15%', 'rose\n 15%') }));
  assert.deepEqual(pickProblems(good(), c2), []);
});

test('too-long fields are fixable feedback', () => {
  const p = good(); p.articles[0].coverLine = 'x'.repeat(70);
  assert.match(pickProblems(p, cands).join(), /coverLine is 70 chars, max 50/);
});

test('a package that fails any gate is held and raises a health-alert issue', async () => {
  const wf = await fs.readFile(new URL('../.github/workflows/midday-realsource.yml', import.meta.url), 'utf8');
  assert.match(wf, /issues: write/);
  assert.match(wf, /Held — open or update the health-alert issue/);
  assert.match(wf, /--label health-alert/);
  assert.match(wf, /steps\.build\.outputs\.code == '0'/, 'a failed build never reaches the gates');
});

test('a trailing comma is not part of a number', () => {
  const p = good(); p.articles[0].captionLine = 'Profit 15%, ₹1,200 crore, sab upar';
  assert.deepEqual(pickProblems(p, cands), []);
});

test('cover gate: the cover claim must come from a chosen article', () => {
  const a = good(); a.hook = 'Crude ऊंचा, OMC पर दबाव'; a.hookTerms = ['Crude', 'OMC'];
  assert.match(pickProblems(a, cands).join(), /hook term "Crude" is not in cand 0/);
  const b = good(); b.hookFrom = 9; assert.match(pickProblems(b, cands).join(), /hookFrom must be/);
  const c = good(); c.hookTerms = ['Profit rose']; c.hook = 'Profit बढ़ा';
  assert.match(pickProblems(c, cands).join(), /hook must contain the term "Profit rose"/);
  const d = good(); d.hookTerms = []; assert.match(pickProblems(d, cands).join(), /hookTerms needs/);
});
