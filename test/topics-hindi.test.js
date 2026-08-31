// The repeat check ran on every generated carousel and could never once have
// fired. fingerprint() kept a-z0-9 and discarded everything else, so a Hindi
// topic reduced to the empty string, and tooSimilar() returns false the moment
// either side is empty -- including a topic compared with itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fingerprint, tooSimilar } from '../pipeline/src/script/topics.js';

test('a Hindi topic has a fingerprint at all', () => {
  assert.notEqual(fingerprint('ग्रहों की घूर्णन अवधि'), '');
});

test('the same Hindi topic is recognised as the same topic', () => {
  const topic = 'ऑक्टोपस के तीन दिल';
  assert.equal(tooSimilar(topic, topic), true);
});

test('the same subject reworded is caught', () => {
  assert.equal(tooSimilar('ऑक्टोपस के तीन दिल', 'तीन दिल वाला ऑक्टोपस'), true);
});

test('two different subjects are not confused', () => {
  assert.equal(tooSimilar('ऑक्टोपस के तीन दिल', 'प्राचीन मिस्र की चिकित्सा'), false);
});

// Hindi grammar is not a subject. Without the stopwords, two unrelated topics
// would look alike because both contain "की" and "के".
test('grammar words do not make two topics similar', () => {
  assert.equal(fingerprint('मंगल की सतह').includes('की'), false);
  assert.equal(tooSimilar('मंगल की सतह पर', 'चींटी के पैर की ताक़त'), false);
});

test('English topics still work as before', () => {
  assert.equal(tooSimilar('HDFC Bank Q2 results', 'Q2 results of HDFC Bank'), true);
  assert.equal(tooSimilar('HDFC Bank Q2 results', 'Monsoon forecast update'), false);
});
