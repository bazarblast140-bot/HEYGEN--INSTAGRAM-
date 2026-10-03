// Cover photo (slide 1 only): relevant, Indian for finance, no documents /
// forms / foreign text, no visible text; otherwise the chart cover. The US
// Form 1040 that reached the 3 Oct SBI EMI post is the case this guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
  photoRequest, rejectReason, rankCandidates, textFromTsv, visibleTextReason, attachCoverPhoto,
} from '../pipeline/src/carousel/cover-photo.js';
import { boardSlides } from '../pipeline/src/carousel/board.js';
import { applyEdits } from '../pipeline/src/carousel/edits.js';

const FIN = {
  category: 'personal-finance',
  topic: 'EMI का गणित',
  coverPhoto: { queries: ['Indian family new home', 'apartment building India'], mustHave: ['home', 'apartment', 'house'], avoid: ['calculator'] },
  slides: [
    { band: 'center', headline: 'हर EMI में interest कितना?', cta: false },
    { band: 'bottom', headline: 'EMI', subline: '₹50 लाख, 8.5%, 20 साल', calc: { type: 'emi', principal: 5000000, rate: 8.5, years: 20 }, cta: false },
    { band: 'bottom', headline: 'सेव करो', subline: 'फ़ॉलो करो', cta: true },
  ],
};
const cand = (meta, extra = {}) => ({ id: `x:${meta.length}:${meta.slice(0, 8)}`, meta, alt: meta, image: 'https://example.org/p.jpg', width: 3000, height: 2000, licence: 'CC BY 3.0', licenceOk: true, source: 'Wikimedia Commons', page: 'https://commons.wikimedia.org/wiki/File:x.jpg', credit: 'A / Wikimedia Commons', ...extra });

test('finance searches always carry India; must-have and avoid come from the model', () => {
  const r = photoRequest(FIN);
  assert.deepEqual(r.queries, ['Indian family new home', 'apartment building India']);
  assert.equal(r.finance, true);
  assert.deepEqual(photoRequest({ ...FIN, coverPhoto: { queries: ['house keys new home'] } }).queries, ['house keys new home India']);
  assert.deepEqual(photoRequest({ category: 'ai-news', coverPhoto: { queries: ['Nvidia GPU'] }, slides: [] }).queries, ['Nvidia GPU']);
});

test('documents, forms, foreign context and off-topic photos are rejected by their metadata', () => {
  const r = photoRequest(FIN);
  assert.match(rejectReason(cand('1040 U.S. Individual Income Tax Return form'), r), /document/);
  assert.match(rejectReason(cand('house keys on an invoice paper'), r), /document/);
  assert.match(rejectReason(cand('Suburban home in Florida with dollar bills'), r), /foreign/);
  assert.match(rejectReason(cand('Indians at home on the Klamath Reservation, Oregon'), r), /foreign/);
  assert.match(rejectReason(cand('Modern apartment house exterior'), r), /no Indian context/);
  assert.match(rejectReason(cand('Mumbai street food stall India'), r), /must-have/);
  assert.match(rejectReason(cand('Indian home with a calculator'), r), /document|avoid/);
  assert.match(rejectReason(cand('Apartments in Hyderabad, India', { licenceOk: false, licence: 'CC BY-NC' }), r), /licence/);
  assert.match(rejectReason(cand('The President of India with Probationers of Indian Ordnance Factories'), photoRequest({ ...FIN, coverPhoto: { queries: ['Indian factory'], mustHave: ['factory', 'factories'] } })), /news photo of people/);
  assert.equal(rejectReason(cand('Indu Fortune Fields Gardenia Apartments in Hitec City, Hyderabad · Apartment buildings in Hyderabad, India'), r), null);
  const ranked = rankCandidates([cand('1040 tax form'), cand('Apartments in Hyderabad, India')], r);
  assert.equal(ranked[0].reason, null, 'a passing photo ranks first');
  const news = photoRequest({ category: 'ai-news', coverPhoto: { queries: ['Nvidia data center GPU'], mustHave: ['nvidia'] }, slides: [] });
  assert.equal(rejectReason(cand('Nvidia H100 GPU on a desk'), news), null, 'news needs the actual subject, not India');
  assert.match(rejectReason(cand('Generic server room'), news), /must-have/);
});

test('visible text: words or long numbers in the photo reject it', () => {
  const row = (conf, word) => `5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t${conf}\t${word}`;
  const head = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const form = textFromTsv([head, row(91, 'Individual'), row(90, 'Income'), row(93, 'Tax'), row(88, 'Return'), row(85, '1040')].join('\n'));
  assert.match(visibleTextReason(form), /numbers printed in the photo \(1040\)/);
  const noise = textFromTsv([head, row(31, 'ar'), row(12, 'LLL'), row(45, 'TOT.'), row(60, 'mr')].join('\n'));
  assert.equal(visibleTextReason(noise), null, 'low-confidence OCR noise from windows is not text');
  assert.equal(visibleTextReason(null), null, 'no tesseract: metadata check only');
});

test('attach: first candidate that passes metadata and text checks; else the chart cover; never throws', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cover-'));
  const search = {
    pexels: async () => [cand('1040 tax form on desk', { source: 'Pexels', licence: 'Pexels License' })],
    commons: async () => [cand('Apartment buildings in Hyderabad, India with signage'), cand('Apartments in Hitec City, Hyderabad, India')],
  };
  const fetchFile = async (url, dest) => { await fs.writeFile(dest, 'jpg'); return dest; };
  const got = await attachCoverPhoto(FIN, { outDir, key: 'k', search, fetchFile, readText: async () => ({ words: [], numbers: [] }) });
  assert.equal(got.photo.used, true);
  assert.equal(got.photo.alt, 'Apartments in Hitec City, Hyderabad, India');
  assert.equal(got.photo.licence, 'CC BY 3.0');
  assert.ok(got.photo.page && got.photo.source && got.photo.credit);
  assert.ok(got.photo.rejected.some((r) => /document/.test(r.reason)));
  assert.match(got.spec.slides[0].photo.credit, /^Photo: A \/ Wikimedia Commons · CC BY 3\.0$/);
  assert.equal(got.spec.slides[1].photo, undefined, 'inner slides never get a photo');

  const texty = await attachCoverPhoto(FIN, { outDir, key: 'k', search, fetchFile, readText: async () => ({ words: ['SALE', 'FLAT', 'NOW'], numbers: [] }) });
  assert.equal(texty.photo.used, false);
  assert.equal(texty.spec, FIN, 'spec unchanged → chart cover');

  const broken = await attachCoverPhoto(FIN, { outDir, key: 'k', search: { pexels: async () => { throw new Error('429'); }, commons: async () => { throw new Error('down'); } }, fetchFile });
  assert.equal(broken.photo.used, false);
  assert.match(broken.photo.reason, /no candidates/);
  const nokey = await attachCoverPhoto({ ...FIN, coverPhoto: null, slides: [{ ...FIN.slides[0], query: 'indian stock exchange' }, ...FIN.slides.slice(1)] }, { outDir, key: '', search: { commons: async () => [] }, fetchFile });
  assert.equal(nokey.photo.used, false);
});

test('the board puts the photo on the cover only, with the chart dropped and the figure strip kept', () => {
  const spec = { ...FIN, slides: [{ ...FIN.slides[0], photo: { file: '/tmp/x.jpg', credit: 'Photo: A / Pexels' } }, ...FIN.slides.slice(1)] };
  const b = boardSlides(spec);
  assert.equal(b[0].photo, 'file:///tmp/x.jpg');
  assert.equal(b[0].chart, null);
  assert.ok(b[0].figures.length, 'computed figures stay on the cover');
  assert.equal(b[1].photo, undefined);
  assert.ok(b[1].chart);
  assert.equal(boardSlides(FIN)[0].chart.kind, 'split', 'no photo → the chart cover');
});

test('a cover_photo edit asks for a photo on a re-render (no model call)', () => {
  const { spec, applied } = applyEdits(FIN, [{ op: 'cover_photo', queries: ['Indian factory workers India'], mustHave: ['factory'], avoid: ['logo'] }]);
  assert.deepEqual(spec.coverPhoto, { queries: ['Indian factory workers India'], mustHave: ['factory'], avoid: ['logo'] });
  assert.match(applied[0], /cover photo: search "Indian factory workers India"/);
  assert.throws(() => applyEdits(FIN, [{ op: 'cover_photo', queries: [] }]), /needs at least one query/);
});
