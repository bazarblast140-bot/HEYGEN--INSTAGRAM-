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
// Sixteen subjects, twice each. It used to be eight, with space four times
// over and everything else once to three times, and the feed read as two
// things: space and AI. Nothing on the account was about food, medicine,
// language, sport, weather, plants, transport or India at all.
//
// Two of each rather than a weighting, because a weighting is how space came
// to be a fifth of the account. Thirty-two entries and a stride of five stay
// coprime, so every subject comes round before any repeats.
// Sixteen subjects, once each, and the rotation does the rest.
//
// It used to be eight subjects with space listed four times over, and the
// account read as two things: space and AI. Nothing on it was ever about food,
// medicine, language, sport, weather, plants, transport or India.
//
// Once each, not weighted: a weighting is exactly how space came to be a fifth
// of everything. Sixteen entries with a stride of five are coprime, and the
// evening offset is half the pool, so over any sixteen days every subject gets
// exactly one morning and one evening -- no subject twice before all of them
// have had a turn.
export const POOL = [
  'space',
  'science',
  'body',
  'technology',
  'history',
  'geography',
  'animals',
  'economy',
  'food',
  'medicine',
  'language',
  'sports',
  'weather',
  'plants',
  'transport',
  'india',
];

export const STRIDE = 5;

// How many slides a post carries.
//
// Nine, not six: a carousel's reach is driven by how long people stay on it,
// and three more slides is three more swipes without three more facts to find.
// The last is always the follow card, so nine slides is eight of substance.
// Instagram's own ceiling is ten -- see MAX_ITEMS in publish/carousel.js.
export const SLIDES = 9;

/**
 * Two posts a day, and the second one must not be a rerun of the first.
 *
 * The day's stride solves "yesterday vs today"; it says nothing about the two
 * posts inside one day, which land on the same index and so the same category.
 * The evening post steps a further 10.
 *
 * Ten works for the same reason five does. The sequence of indices becomes
 * d*5, d*5+10, (d+1)*5, ... so the gaps alternate +10 and -5, and both are
 * further than the longest block of one category (4) is wide — a block spans at
 * most indices i..i+3, so anything four or more apart is a different category
 * outright. And because each slot walks the whole pool once per cycle, the
 * weights still hold exactly: over 21 days each category comes up twice its
 * weight, not once with a fudge.
 */
// Half the pool. At 10 the evening pick was the morning pick of two days
// later, so subjects came in pairs and a three-week stretch could miss some
// entirely; at half the length the same collision is sixteen days away, which
// is the whole cycle.
export const SLOT_OFFSET = 8;

/**
 * The two slots this rotation covers. The midday post is deliberately NOT here:
 * it is built from fetched news rather than chosen from a category pool, so it
 * has no place in the walk and must not consume one of its steps.
 */
export const SLOTS = ['morning', 'evening'];

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
  food: 'खाना, मसाले, फ़सलें, रसोई का विज्ञान, पेय',
  medicine: 'दवाइयाँ, टीके, बीमारियाँ, इलाज का इतिहास, सर्जरी',
  language: 'भाषाएँ, लिपियाँ, शब्दों की जड़ें, अनुवाद',
  sports: 'खेल, रिकॉर्ड, खिलाड़ियों के आँकड़े, खेल का विज्ञान',
  weather: 'मौसम, तूफ़ान, बारिश, बिजली, मौसम का अनुमान',
  plants: 'पेड़, जंगल, फूल, बीज, प्रकाश संश्लेषण',
  transport: 'रेल, हवाई जहाज़, जहाज़, सड़क, इंजन',
  india: 'भारत के तथ्य — नक्शा, रिकॉर्ड, संस्कृति, निर्माण, रेलवे',
};

/** Days since the epoch — the same date always chooses the same category. */
export function dayNumber(date = new Date()) {
  const iso = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
}

/**
 * Which slot a run belongs to, worked out from the clock rather than passed in.
 *
 * A scheduled run knows its own cron only as a time, and a hand-started run
 * knows nothing at all, so guessing wrong would be silent. IST is UTC+5:30: the
 * 06:00 post fires at 00:30 UTC and the 17:00 post at 11:30 UTC, and any hour
 * before 06:00 UTC is unambiguously the morning one, and the midday post sits
 * in the wide gap between them.
 */
/**
 * Which slot a cron entry is FOR, regardless of when the runner gets to it.
 *
 * slotFor() reads the clock, and the clock lies about intent. GitHub's
 * scheduler is best-effort and has been firing these entries six to eight
 * hours late: the 00:37 morning entry ran at 07:05, where slotFor() sees hour 7
 * and answers "midday". The morning post could not happen -- not dropped, not
 * failed, just relabelled on arrival.
 *
 * The cron string is what GitHub hands the run in `github.event.schedule`, and
 * it says what the run was scheduled to be. A delayed morning post is late; a
 * morning post that became a midday post is gone.
 *
 * Keep this table and the workflow's `on.schedule` identical -- a test asserts
 * it, because an entry missing here falls back to the clock and the failure is
 * invisible until a post does not appear.
 */
export const CRON_SLOTS = {
  '37 0 * * *': 'morning',
  '22 1 * * *': 'morning',
  '48 2 * * *': 'morning',
  '37 7 * * *': 'midday',
  '22 8 * * *': 'midday',
  '48 9 * * *': 'midday',
  '37 11 * * *': 'evening',
  '22 12 * * *': 'evening',
  '48 13 * * *': 'evening',
};

export function slotForCron(cron) {
  const key = String(cron || '').trim().replace(/\s+/g, ' ');
  return CRON_SLOTS[key] || null;
}

export function slotFor(date = new Date()) {
  const hour = typeof date === 'string' ? 0 : date.getUTCHours();
  if (hour < 6) return 'morning';      // 06:07 IST fires at 00:37 UTC
  if (hour < 11) return 'midday';      // 13:07 IST fires at 07:37 UTC
  return 'evening';                    // 17:07 IST fires at 11:37 UTC
}

export function categoryFor(date = new Date(), slot = 'morning') {
  const index = SLOTS.indexOf(slot);
  if (index === -1) throw new Error(`Unknown slot "${slot}" — ${SLOTS.join(' or ')}.`);
  return POOL[(dayNumber(date) * STRIDE + index * SLOT_OFFSET) % POOL.length];
}
