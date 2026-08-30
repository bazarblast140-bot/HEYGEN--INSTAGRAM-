// Which kind of subject today's carousel covers.
//
// The pool is weighted by repetition: a category that should come up more often
// simply appears more times. That is the simple part. The walk is the part with
// a trap in it.
//
// Walking the pool one step a day looks obviously right and is wrong, because
// entries of the same category sit next to each other — so four "space" entries
// in a row means four space days in a row, which is exactly the repetition the
// weighting was supposed to spread out.
//
// So the walk takes a stride of 5. Five is coprime with the pool length (21), so
// the cycle still visits every entry exactly once before repeating — the weights
// are preserved to the letter. But because the stride is longer than the longest
// block of one category, two consecutive days can never land in the same block.
// The weight decides how often; the stride decides how far apart.

/** Weights are entry counts. They must sum to a length coprime with STRIDE. */
export const POOL = [
  ...Array(4).fill('space'),
  ...Array(3).fill('science'),
  ...Array(3).fill('body'),
  ...Array(3).fill('technology'),
  ...Array(3).fill('history'),
  ...Array(2).fill('geography'),
  ...Array(2).fill('animals'),
  ...Array(1).fill('economy'),
];

export const STRIDE = 5;

/**
 * What each category is about, in the words the prompt needs. Kept here rather
 * than in the prompt so that adding a category is one edit, not two.
 */
export const BRIEFS = {
  space: 'ग्रह, तारे, अंतरिक्ष मिशन, ब्रह्मांड के पैमाने',
  science: 'भौतिकी, रसायन, गणित, प्रकृति के नियम',
  body: 'मानव शरीर, दिमाग, नींद, इंद्रियाँ',
  technology: 'इंटरनेट, चिप, AI, इंजीनियरिंग',
  history: 'प्राचीन सभ्यताएँ, आविष्कार, ऐतिहासिक घटनाएँ',
  geography: 'पृथ्वी, महासागर, पहाड़, जलवायु',
  animals: 'जानवर, पक्षी, समुद्री जीव, उनकी क्षमताएँ',
  economy: 'पैसा, कंपनियाँ, व्यापार, मुद्रा',
};

/** Days since the epoch — the same date always chooses the same category. */
export function dayNumber(date = new Date()) {
  const iso = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
}

export function categoryFor(date = new Date()) {
  return POOL[(dayNumber(date) * STRIDE) % POOL.length];
}
