// Finance-first Instagram carousel categories for @rajesh_technical_trader.
// Every scheduled carousel teaches one useful money/market concept with a concrete, sourceable angle.

export const POOL = [
  'fundamentals', 'options', 'intraday', 'stocks',
  'market-history', 'personal-finance', 'business', 'risk-management',
];

export const STRIDE = 5;
export const SLIDES = 10;
export const SLOT_OFFSET = 8;
export const SLOTS = ['evening'];
export const FINANCE = POOL;

export const BRIEFS = {
  fundamentals: 'कंपनी को पढ़ना: revenue, profit, EPS, ROE, ROCE, debt, margins, cash flow, valuation और promoter/shareholding data. हर post एक metric या connected idea को example के साथ समझाए.',
  options: 'Options की practical education: calls/puts, moneyness, Greeks, IV, expiry, payoff, breakeven और defined-risk strategies. Strategy को example और maximum-risk explanation के साथ समझाओ; profit promise नहीं.',
  intraday: 'Intraday education: opening range, VWAP, volume, volatility, trend structure, entries/exits के नियम, position sizing और no-trade conditions. कोई live tip या personalized call नहीं.',
  stocks: 'Indian stocks की educational case studies: strong business, turnaround, compounders, small-cap और historical high-return examples. Price return को dates, corporate actions और basis के साथ verify करो; penny stocks में historical study और risk framework.',
  'market-history': 'भारतीय market की महत्वपूर्ण घटनाएँ, पुराने bull/bear phases, index milestones, crashes, bubbles, settlements और trading-system changes — numbers और dates के साथ.',
  'personal-finance': 'Compounding, emergency fund, inflation, loans, credit score, taxes, asset allocation और money mistakes — practical calculations के साथ.',
  business: 'Companies और business models: revenue कैसे बनता है, unit economics, margins, moats, failures, IPO/business history और famous Indian corporate case studies.',
  'risk-management': 'Capital protection: position sizing, drawdown math, risk-reward, leverage, stop-loss mechanics, diversification और trading psychology. कोई guaranteed outcome नहीं.',
};

export function dayNumber(date = new Date()) {
  const iso = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  return Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);
};

export const CRON_SLOTS = {
  '37 0 * * *': 'morning', '22 1 * * *': 'morning', '48 2 * * *': 'morning',
  '37 7 * * *': 'midday', '22 8 * * *': 'midday', '48 9 * * *': 'midday',
  '37 11 * * *': 'evening', '22 12 * * *': 'evening', '48 13 * * *': 'evening',
};

export function slotForCron(cron) {
  const key = String(cron || '').trim().replace(/\s+/g, ' ');
  return CRON_SLOTS[key] || null;
};

export function slotFor(date = new Date()) {
  const hour = typeof date === 'string' ? 0 : date.getUTCHours();
  if (hour < 6) return 'morning';
  if (hour < 11) return 'midday';
  return 'evening';
};

export function categoryFor(date = new Date(), slot = 'evening') {
  if (slot === 'evening') return FINANCE[dayNumber(date) % FINANCE.length];
  const index = SLOTS.indexOf(slot);
  if (index === -1) throw new Error('Unknown slot ' + slot + ' — ' + SLOTS.join(' or ') + '.');
  return POOL[(dayNumber(date) * STRIDE + index * SLOT_OFFSET) % POOL.length];
};