// The article beat has two rules that are invisible until the reel is watched:
// the scroll needs somewhere to go, and the source must be credited. Both are
// enforced when the spec is validated, so a bad one never reaches a render.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const BODY = [
  'Monthly contributions through systematic investment plans rose again in July, industry data showed.',
  'Fund houses reported a rise in new SIP registrations, led by first-time investors outside the metros.',
  'Equity schemes took the larger share, though debt and hybrid categories also saw net additions.',
  'The figure marks the twenty-fourth consecutive month of increase, with no single month recording a fall.',
  'Analysts cautioned that flows can reverse quickly if returns stay flat for several quarters.',
];

/** Where does the highlight land, and is that far enough down to be worth scrolling to? */
function paragraphOf(body, highlight) {
  return body.findIndex((l) => l.toLowerCase().includes(String(highlight).toLowerCase()));
}

test('the shipped spec puts its highlight late enough to scroll to', async () => {
  const spec = JSON.parse(await readFile(new URL('../pipeline/specs/sip.json', import.meta.url), 'utf8'));
  const beat = spec.segments.find((s) => s.type === 'article');
  assert.ok(beat, 'the spec should exercise the article beat');

  const { article } = beat;
  assert.ok(article.source?.trim(), 'the source must be credited on screen');
  assert.ok(article.body.length >= 4, 'a document needs enough lines to scroll through');

  const at = paragraphOf(article.body, article.highlight);
  assert.ok(at >= 2, `highlight is in paragraph ${at + 1}; paragraph 1 or 2 is already on screen`);
});

test('a highlight in paragraph one or two travels almost nothing', () => {
  // Measured on the real scene: with the phrase in paragraph 2 the scroll moved
  // 0px, and the shot read as a still. Paragraph 4 moved 382px.
  assert.equal(paragraphOf(BODY, 'rose again in July'), 0);
  assert.equal(paragraphOf(BODY, 'twenty-fourth consecutive month'), 3);
});

test('a highlight that is not in the body cannot be marked', () => {
  assert.equal(paragraphOf(BODY, 'a phrase nobody wrote'), -1);
});

test('the scene credits its source rather than dressing as one', async () => {
  const html = await readFile(new URL('../pipeline/src/render/scenes/article.html', import.meta.url), 'utf8');

  // The sheet must use the brand's own palette variables, not a publication's.
  assert.match(html, /--ground: #020617/, 'the sheet keeps the brand ground');
  assert.match(html, /id="sourceName"/, 'the source is rendered on screen');
  // Source and date are joined into the strip; neither may be silently dropped.
  assert.match(html, /\[payload\.source, payload\.date\]/);
});
