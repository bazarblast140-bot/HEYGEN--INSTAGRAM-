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
// Sixteen subjects, once each, and the rotation does the rest.
export const POOL = [
  'space',
  'science',
  'body',
  'technology',
  'history',
  'geography',
  'animals',
  'buildings',
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
// 24-Sep-2026: raised from 9 → 10 (Instagram ceiling).
// Last slide is always the follow card, so 10 slides = 9 of substance.
export const SLIDES = 10;

// Half the pool. Keeps morning vs evening subjects far apart.
export const SLOT_OFFSET = 8;

/**
 * The two slots this rotation covers. The midday post is deliberately NOT here:
 * it is built from fetched news rather than chosen from a category pool, so it
 * has no place in the walk and must not consume one of its steps.
 */
export const SLOTS = ['morning', 'evening'];

// Evening — money. Facts and history, never advice.
export const FINANCE = [
  'markets',
  'money',
  'economy',
  'business',
  'banking',
  'tax',
  'insurance',
  'scams',
];

// English briefs — useful educational angle, not random trivia.
export const BRIEFS = {
  space: 'planets, stars, space missions, scale of the universe — concrete numbers and real missions',
  science: 'physics, chemistry, maths, laws of nature — how things actually work',
  body: 'human body, brain, sleep, senses — practical and surprising mechanisms',
  technology: 'internet, chips, AI, engineering — how the tools we use every day work',
  history: 'civilisations, inventions, key events — cause and effect, not just dates',
  geography: 'Earth, oceans, mountains, climate — real systems and numbers',
  animals: 'animals, birds, sea life — capabilities and adaptations that matter',
  food: 'food, spices, crops, kitchen science — chemistry and history you can use',
  medicine: 'medicines, vaccines, diseases, surgery history — real medical facts',
  language: 'languages, scripts, word origins — how communication evolved',
  sports: 'sports, records, athlete data, sports science — numbers and mechanics',
  weather: 'weather, storms, rain, lightning, forecasting — how prediction works',
  plants: 'trees, forests, flowers, seeds, photosynthesis — living systems',
  transport: 'rail, aircraft, ships, roads, engines — engineering that moves us',
  india: 'India facts — maps, records, culture, infrastructure, railways',
  buildings: 'buildings, bridges, dams, tunnels, architecture numbers',

  // Evening — money. Facts and history, never advice.
  markets: 'how stock markets work — indices, circuits, IPOs, historical crashes',
  money: 'history of money — notes, coins, inflation, UPI, spotting fakes',
  economy: 'GDP, jobs, trade, India economy numbers — how the system works',
  business: 'how companies rose and fell, brand stories, business numbers',
  banking: 'banks, interest, RBI, compounding, loans and EMI maths',
  tax: 'how tax works, GST, history, unusual tax stories worldwide',
  insurance: 'how insurance works, risk maths, claim statistics',
  scams: 'famous financial scams — how they worked, how they were caught, how to avoid',
};

/** Days since the epoch — the same date always chooses the same category. */
export function dayNumber(date = new Date()) {
  const iso = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
}

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
  // Evening stays money. Morning stays general useful facts.
  if (slot === 'evening') {
    return FINANCE[dayNumber(date) % FINANCE.length];
  }

  const index = SLOTS.indexOf(slot);
  if (index === -1) throw new Error(`Unknown slot "${slot}" — ${SLOTS.join(' or ')}.`);
  return POOL[(dayNumber(date) * STRIDE + index * SLOT_OFFSET) % POOL.length];
}
