// Instagram carousel categories for @rajesh_technical_trader.
// 4 slots/day → 4 different topics:
//   morning   → finance education (rotating)
//   midday    → latest AI topics / tech AI news
//   afternoon → latest news (markets + tech + India)
//   evening   → finance education (rotating)

export const POOL = [
  'fundamentals', 'options', 'intraday', 'stocks',
  'market-history', 'personal-finance', 'business', 'risk-management',
];

export const STRIDE = 5;
export const SLIDES = 10;
export const SLOT_OFFSET = 8;
export const SLOTS = ['morning', 'midday', 'afternoon', 'evening'];
export const FINANCE = POOL;

export const TOPIC_SEEDS = {
  fundamentals: [
    'Earnings quality: profit बढ़ा लेकिन operating cash flow क्यों नहीं बढ़ा',
    'ROCE और capital employed: asset-heavy business को कैसे पढ़ें',
    'Gross margin बनाम net margin: असली फर्क कहाँ दिखता है',
    'Free cash flow positive होने के बावजूद stock महँगा कैसे हो सकता है',
    'Promoter pledge घटने-बढ़ने का balance sheet पर क्या मतलब',
    'Working capital बढ़े तो profit की quality पर क्या सवाल उठता है',
    'PEG ratio कब useful है और कब misleading',
    'Inventory तेजी से बढ़े तो annual report में क्या देखें',
    'Interest coverage ratio से debt pressure कैसे समझें',
    'Operating leverage: sales बढ़ने पर profit तेजी से क्यों बदल सकता है',
  ],
  options: [
    'Option premium के दो हिस्से: intrinsic value और time value',
    'IV crush: result के बाद option premium क्यों गिर सकता है',
    'Delta 0.50 का practical मतलब एक ₹100 move में क्या है',
    'Theta weekend/expiry के आसपास कैसे काम करता है',
    'Bull Call Spread का payoff एक simple NIFTY example से',
    'Bear Put Spread में risk और reward कैसे सीमित होते हैं',
    'Protective Put: stock holding के साथ insurance जैसा setup',
    'Long Straddle में बड़ा move चाहिए, direction नहीं',
    'Covered Call में premium के बदले upside कैसे limit होती है',
    'Expiry पर ATM option का behavior क्यों बदलता है',
  ],
  intraday: [
    'Opening range के बाहर breakout और volume confirmation',
    'VWAP से दूर price भागे तो mean reversion का concept',
    'Gap-up के बाद पहला 15-minute range क्या बताता है',
    'Trend day और range day में trading approach क्यों बदलती है',
    'Volume spike और price stall: demand सच में है या नहीं',
    'ATR से intraday position size कैसे calculate करें',
    'पहले घंटे में trade न करना कब बेहतर हो सकता है',
    'False breakout पहचानने के लिए close + volume कैसे देखें',
    'Risk per trade से quantity अपने आप कैसे निकलती है',
    'Intraday में stop distance और position size का उल्टा रिश्ता',
  ],
  stocks: [
    'Historical compounder case study: business growth ने valuation को कैसे support किया',
    'एक turnaround stock में revenue से पहले कौन से संकेत दिख सकते हैं',
    'High-return stock: price CAGR और business CAGR में फर्क',
    'Penny stock case study: low price के पीछे share dilution का असर',
    'Small-cap में promoter holding और pledge को कैसे पढ़ें',
    'Bonus/split के बाद पुराने stock return को सही तरीके से कैसे calculate करें',
    'Dividend-adjusted return बनाम सिर्फ price return',
    'एक शानदार stock भी गलत valuation पर खराब investment क्यों बन सकता है',
    '52-week high देखकर company quality तय करना क्यों गलत है',
    'Historical multibagger को आज के stock से compare करने की सही पद्धति',
  ],
  'market-history': [
    'Indian market के बड़े crash में index drawdown कैसे measure होता है',
    'NIFTY/SENSEX में base year और base value का मतलब',
    'Demat और electronic settlement ने Indian markets कैसे बदले',
    'T+1 settlement तक पहुँचने की कहानी',
    'Market-wide circuit breakers कैसे काम करते हैं',
    'Bull market में valuation multiples कैसे बदलते हैं',
    'IPO boom और listing price के बीच historical gap',
    'Index में stock जोड़ने/हटाने का passive funds पर असर',
  ],
  'personal-finance': [
    'Inflation 6% हो तो ₹1 lakh की purchasing power कितनी घटती है',
    'EMI में principal और interest का हिस्सा समय के साथ कैसे बदलता है',
    'Credit score में payment history क्यों महत्वपूर्ण है',
    'Emergency fund को monthly expenses से कैसे calculate करें',
    'Compounding में return से ज्यादा time क्यों मायने रखता है',
    'Loan prepayment बनाम investing: comparison कैसे करें',
    'Nominal salary growth और real income growth का फर्क',
    'Tax-saving और tax-free एक ही चीज़ क्यों नहीं हैं',
  ],
  business: [
    'Business moat: switching cost और network effect में फर्क',
    'Revenue बढ़ रहा हो लेकिन margins गिरें तो क्या पढ़ें',
    'Asset-light business का ROCE अक्सर अलग क्यों दिखता है',
    'IPO prospectus में risk factors को कैसे पढ़ें',
    'Unit economics: customer acquisition cost बनाम lifetime value',
    'Failed company case study: growth के बावजूद cash क्यों खत्म हुआ',
    'Operating cash flow और EBITDA में practical फर्क',
    'Brand strong होने के बावजूद business model कमजोर कैसे हो सकता है',
  ],
  'risk-management': [
    'Drawdown 20% के बाद break-even के लिए 25% return क्यों चाहिए',
    'Position sizing: ₹1 lakh capital और fixed risk से quantity निकालना',
    'Risk-reward ratio और win rate का mathematical relationship',
    'Leverage में छोटा adverse move capital पर बड़ा असर क्यों डालता है',
    'Stop-loss distance बदलने पर quantity क्यों बदलनी चाहिए',
    'Portfolio concentration का risk एक simple example से',
    'Revenge trading के बाद position size बढ़ाना क्यों dangerous है',
    'Trading journal में कौन से numbers track करने चाहिए',
  ],
  // Latest AI — model must pick CURRENT / recent AI headlines (last few days).
  'ai-news': [
    'आज की सबसे बड़ी AI खबर: OpenAI / Google / Meta / Anthropic में से जो सबसे नया हो',
    'नया AI model या API launch — capability, pricing, India impact',
    'AI safety / regulation / copyright की ताज़ा खबर',
    'India में AI policy, startup funding या product launch',
    'AI tools जो traders / creators / students के काम आएँ — fresh release',
    'Chip / GPU / data-center AI infrastructure की latest development',
    'AI agent / automation की नई capability — practical example',
    'Big Tech AI product update: ChatGPT, Gemini, Claude, Grok, Copilot',
  ],
  // Latest news digest — current events, not evergreen education.
  'latest-news': [
    'आज की top 3 tech / market खबरें — short Hindi explain',
    'Indian markets / RBI / SEBI / policy की ताज़ा development',
    'Global market move जो Indian investors को affect करे',
    'IPO / listing / corporate action की fresh news',
    'Cybersecurity / data breach / platform policy change',
    'Phone / gadget / EV launch जो India relevant हो',
    'Startup funding / shutdown / big deal की latest story',
    'Economy indicator: inflation, jobs, GDP, crude — अगर आज relevant हो',
  ],
};

export const BRIEFS = {
  fundamentals: 'कंपनी को पढ़ना: revenue, profit, EPS, ROE, ROCE, debt, margins, cash flow, valuation और promoter/shareholding data. हर post एक metric या connected idea को example के साथ समझाए.',
  options: 'Options की practical education: calls/puts, moneyness, Greeks, IV, expiry, payoff, breakeven और defined-risk strategies. Strategy को example और maximum-risk explanation के साथ समझाओ; profit promise नहीं.',
  intraday: 'Intraday education: opening range, VWAP, volume, volatility, trend structure, entries/exits के नियम, position sizing और no-trade conditions. कोई live tip या personalized call नहीं.',
  stocks: 'Indian stocks की educational case studies: strong business, turnaround, compounders, small-cap और historical high-return examples. Price return को dates, corporate actions और basis के साथ verify करो; penny stocks में historical study और risk framework.',
  'market-history': 'भारतीय market की महत्वपूर्ण घटनाएँ, पुराने bull/bear phases, index milestones, crashes, bubbles, settlements और trading-system changes — numbers और dates के साथ.',
  'personal-finance': 'Compounding, emergency fund, inflation, loans, credit score, taxes, asset allocation और money mistakes — practical calculations के साथ.',
  business: 'Companies और business models: revenue कैसे बनता है, unit economics, margins, moats, failures, IPO/business history और famous Indian corporate case studies.',
  'risk-management': 'Capital protection: position sizing, drawdown math, risk-reward, leverage, stop-loss mechanics, diversification और trading psychology. कोई guaranteed outcome नहीं.',
  'ai-news': 'LATEST AI news only (last 1–7 days). OpenAI, Google, Meta, Anthropic, Microsoft, Apple, Indian AI startups, models, agents, regulation, chips. हर slide पर concrete fact + source-worthy detail. Evergreen theory मत लिखो — आज/इस हफ्ते की खबर. Hindi, clear, no hype promises.',
  'latest-news': 'LATEST news digest (last 1–3 days): Indian markets, tech, policy, startups, gadgets, global events that matter to Indian audience. 3–5 short facts with context. Stale or undated claims avoid करो. Hindi, neutral, educational tone.',
};

export function dayNumber(date = new Date()) {
  const iso = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  return Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);
};

// Main fire + one catch-up per slot (IST).
export const CRON_SLOTS = {
  '37 2 * * *': 'morning', '22 3 * * *': 'morning',
  '37 6 * * *': 'midday', '22 7 * * *': 'midday',
  '37 9 * * *': 'afternoon', '22 10 * * *': 'afternoon',
  '37 11 * * *': 'evening', '22 12 * * *': 'evening',
};

export function slotForCron(cron) {
  const key = String(cron || '').trim().replace(/\s+/g, ' ');
  return CRON_SLOTS[key] || null;
};

export function slotFor(date = new Date()) {
  const hour = typeof date === 'string' ? 0 : date.getUTCHours();
  if (hour < 5) return 'morning';
  if (hour < 8) return 'midday';
  if (hour < 11) return 'afternoon';
  return 'evening';
};

// Fixed mapping so 4 slots always feel different:
// midday = AI, afternoon = news, morning/evening = finance rotation.
export function categoryFor(date = new Date(), slot = 'evening') {
  if (slot === 'midday') return 'ai-news';
  if (slot === 'afternoon') return 'latest-news';
  const index = SLOTS.indexOf(slot);
  if (index === -1) throw new Error('Unknown slot ' + slot + ' — ' + SLOTS.join(' or ') + '.');
  // morning=0, evening=3 → different finance categories
  return POOL[(dayNumber(date) * STRIDE + index * SLOT_OFFSET) % POOL.length];
};
