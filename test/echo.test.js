// Two lines, one fact. Both of these went out on live posts:
//
//   California में Linux को छूट / उम्र सत्यापन कानून से Linux को मिली छूट…
//   पृथ्वी का घूर्णन          / पृथ्वी का घूर्णन धीमा हो रहा है
//
// The reader gets nothing for reading the second line.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { echoes, checkEcho, meaningful } from '../pipeline/src/carousel/echo.js';

test('a headline restated underneath is caught', () => {
  assert.ok(echoes('California में Linux को छूट', 'उम्र सत्यापन कानून से Linux को मिली छूट, सर्वसम्मति से पारित'));
  assert.ok(echoes('पृथ्वी का घूर्णन', 'पृथ्वी का घूर्णन धीमा हो रहा है'));
});

// A name over a figure is the shape that is wanted, and must never trip.
test('a name over a fact passes', () => {
  assert.equal(echoes('शुक्र', 'अपनी धुरी पर एक चक्कर\n243 दिन'), false);
  assert.equal(echoes('गैस टर्बाइन का प्रदूषण', 'मस्क की तेज़ राह, पर्यावरण पर भारी पड़ सकती है'), false);
  assert.equal(echoes('Steam', '12TB पुराने PC गेम्स का\nडेटा लीक हुआ'), false);
});

// Requiring every word was tried first and caught neither live example.
test('most of the words is the test, not all of them', () => {
  assert.ok(echoes('सूरज की गर्मी', 'सूरज की गर्मी बढ़ रही है'));
  assert.equal(echoes('चाँद', 'चाँद पर पानी मिला'), false, 'one word is a name');
});

test('a single shared word is not an echo', () => {
  assert.equal(echoes('मंगल ग्रह', 'मंगल पर धूल भरी आँधियाँ महीनों चलती हैं'), false);
});

test('grammar words do not count', () => {
  assert.deepEqual(meaningful('पृथ्वी का घूर्णन'), ['पृथ्वी', 'घूर्णन']);
});

test('the cover and the follow card are exempt', () => {
  const spec = {
    slides: [
      { band: 'center', headline: 'पृथ्वी का घूर्णन', subline: 'पृथ्वी का घूर्णन धीमा है' },
      { band: 'bottom', headline: 'पृथ्वी का घूर्णन', subline: 'पृथ्वी का घूर्णन धीमा है' },
      { band: 'bottom', cta: true, headline: 'फ़ॉलो करें', subline: 'फ़ॉलो करें FACTVIZER' },
    ],
  };
  const problems = checkEcho(spec);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /slide 2/);
});

test('a slide with no subline is not an echo', () => {
  assert.deepEqual(checkEcho({ slides: [{ band: 'bottom', headline: 'शुक्र' }] }), []);
});

test('a clean carousel reports nothing', () => {
  const spec = {
    slides: [
      { band: 'center', headline: 'क्या आप जानते हैं?' },
      { band: 'bottom', headline: 'शुक्र', subline: 'एक दिन\n243 पृथ्वी दिन' },
      { band: 'bottom', cta: true, headline: 'फ़ॉलो करें' },
    ],
  };
  assert.deepEqual(checkEcho(spec), []);
});
