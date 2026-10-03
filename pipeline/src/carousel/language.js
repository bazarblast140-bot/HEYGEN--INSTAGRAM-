// Simple Hinglish, not textbook Hindi.
//
// The SBI EMI post said "अवधि" and "मूलधन". Nobody says that about their own
// home loan; they say tenure and principal / loan amount. Common English finance
// words are welcome in Roman script (EMI, interest, loan, tenure, SIP, return,
// tax) and do not count against the Devanagari share; heavy Sanskritised words
// are banned in the prompt and at the gate, with the word to use instead.

/** Heavy word → what to write instead. Matched as whole Devanagari words. */
export const HEAVY_WORDS = [
  ['निवेशकों हेतु', 'investors के लिए'],
  ['अवधि', 'tenure / time'],
  ['मूलधन', 'principal / loan amount'],
  ['मूल राशि', 'principal / loan amount'],
  ['प्रतिफल', 'return'],
  ['हेतु', 'के लिए'],
  ['ऋण', 'loan'],
  ['ऋणी', 'borrower'],
  ['परिपक्वता', 'maturity'],
  ['चक्रवृद्धि', 'compounding'],
  ['मुद्रास्फीति', 'inflation'],
  ['लाभांश', 'dividend'],
  ['पूंजीगत लाभ', 'capital gains'],
  ['प्रतिभूति', 'securities'],
  ['प्रतिभूतियों', 'securities'],
  ['अंशधारक', 'shareholder'],
  ['विनियामक', 'regulator'],
  ['अस्थिरता', 'volatility'],
  ['उत्तोलन', 'leverage'],
  ['व्युत्पन्न', 'derivatives'],
  ['सूचकांक', 'index'],
  ['किश्त राशि', 'EMI'],
  ['अर्थात्', 'यानी'],
  ['अर्थात', 'यानी'],
  ['तत्पश्चात', 'उसके बाद'],
  ['उपरोक्त', 'ऊपर वाला'],
  ['एवं', 'और'],
  ['यद्यपि', 'हालाँकि'],
  ['वित्तीय वर्ष', 'financial year'],
  ['आवर्ती', 'monthly / regular'],
];

/** English finance words that are encouraged and never count as "not Hindi". */
export const ENGLISH_OK = [
  'emi', 'emis', 'interest', 'loan', 'loans', 'tenure', 'sip', 'sips', 'return', 'returns', 'tax', 'taxes',
  'principal', 'amount', 'rate', 'rates', 'home', 'car', 'personal', 'total', 'monthly', 'yearly', 'month', 'months',
  'year', 'years', 'fd', 'rd', 'mutual', 'fund', 'funds', 'stock', 'stocks', 'share', 'shares', 'market', 'profit',
  'loss', 'risk', 'trade', 'trader', 'traders', 'trading', 'option', 'options', 'premium', 'strike', 'expiry', 'call', 'put',
  'inflation', 'salary', 'budget', 'invest', 'investment', 'investor', 'investors', 'portfolio', 'breakeven', 'break-even',
  'stop', 'stop-loss', 'target', 'entry', 'exit', 'lot', 'delta', 'theta', 'vega', 'gamma', 'index', 'bank', 'credit',
  'score', 'card', 'prepayment', 'prepay', 'balance', 'gain', 'gains', 'capital', 'compounding', 'value', 'cash', 'flow',
  'income', 'saving', 'savings', 'dividend', 'equity', 'debt', 'bond', 'bonds', 'yield', 'gold', 'growth', 'margin',
  'volatility', 'leverage', 'position', 'size', 'quantity', 'payoff', 'drawdown', 'recovery', 'win', 'rate', 'ratio',
  'calculation', 'formula', 'standard', 'assumed', 'example', 'save', 'follow', 'post', 'link', 'bio', 'account',
  'demat', 'broker', 'company', 'business', 'result', 'results', 'news', 'update', 'ai', 'model', 'chip', 'chips',
  'shareholder', 'regulator', 'securities', 'derivatives', 'maturity', 'time', 'per', 'vs', 'and', 'or', 'of', 'the', 'a',
  'gap', 'up', 'down', 'high', 'low', 'trend', 'volume', 'chart', 'setup', 'level', 'support', 'resistance',
];
const OK = new Set(ENGLISH_OK);

/** Remove encouraged English words before the Devanagari share is counted. */
export function stripAllowedEnglish(text) {
  return String(text || '').replace(/[A-Za-z][A-Za-z-]*/g, (w) => (OK.has(w.toLowerCase()) ? ' ' : w));
}

const NOT_DEV = '(?<![\\u0900-\\u097F])';
const END_DEV = '(?![\\u0900-\\u097F])';
const PATTERNS = HEAVY_WORDS.map(([word, use]) => [new RegExp(`${NOT_DEV}${word}${END_DEV}`, 'u'), word, use]);

/** [{ word, use }] for each banned word in the text. */
export function heavyWordsIn(text) {
  const t = String(text || '');
  const found = [];
  for (const [re, word, use] of PATTERNS) {
    if (re.test(t) && !found.some((f) => f.word.includes(word))) found.push({ word, use });
  }
  return found;
}

export function heavyWordProblems(spec, { caption } = {}) {
  const problems = [];
  (spec?.slides || []).forEach((slide, i) => {
    const hits = heavyWordsIn([slide.headline, slide.subline].filter(Boolean).join(' '));
    for (const { word, use } of hits) problems.push(`slide ${i + 1} uses the heavy word "${word}" — write "${use}" instead`);
  });
  const cap = caption ?? spec?.caption;
  for (const { word, use } of heavyWordsIn(cap)) problems.push(`caption uses the heavy word "${word}" — write "${use}" instead`);
  return problems;
}

/** Prompt block: the list the model is told to avoid. */
export function heavyWordPrompt() {
  return HEAVY_WORDS.map(([w, u]) => `${w} → ${u}`).join(' · ');
}

/** The word to write instead: the first option ("tenure / time" → "tenure"). */
const plainWord = (use) => use.split(' / ')[0];

/**
 * Deterministic repair before the gate: each heavy word in slide text and the
 * caption becomes its plain replacement. Returns { spec, replaced: [word...] }.
 */
export function repairHeavyWords(spec) {
  const replaced = [];
  const fix = (text) => {
    if (text == null) return text;
    let out = String(text);
    for (const [re, word, use] of PATTERNS) {
      const global = new RegExp(re.source, 'gu');
      if (global.test(out)) {
        out = out.replace(global, plainWord(use));
        if (!replaced.includes(word)) replaced.push(word);
      }
    }
    return out;
  };
  const slides = (spec?.slides || []).map((s) => ({ ...s, headline: fix(s.headline), subline: fix(s.subline) }));
  return { spec: { ...spec, slides, caption: fix(spec?.caption) }, replaced };
}
