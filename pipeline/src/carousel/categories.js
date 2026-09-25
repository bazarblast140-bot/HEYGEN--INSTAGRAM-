// Which kind of subject today's carousel covers.

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

// 24-Sep-2026: 9 → 10 (Instagram max). Last = follow card.
export const SLIDES = 10;

export const SLOT_OFFSET = 8;

export const SLOTS = ['evening'];

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

// Hindi briefs — useful educational, not random trivia.
export const BRIEFS = {
  space: 'ग्रह, तारे, अंतरिक्ष मिशन, ब्रह्मांड के पैमाने — असली नंबर और मिशन',
  science: 'भौतिकी, रसायन, गणित, प्रकृति के नियम — चीज़ें कैसे काम करती हैं',
  body: 'मानव शरीर, दिमाग, नींद, इंद्रियाँ — practical और हैरान करने वाले तंत्र',
  technology: 'इंटरनेट, चिप, AI, इंजीनियरिंग — रोज़ के औज़ार कैसे काम करते हैं',
  history: 'सभ्यताएँ, आविष्कार, घटनाएँ — कारण और असर, सिर्फ़ तारीख़ नहीं',
  geography: 'पृथ्वी, महासागर, पहाड़, जलवायु — असली सिस्टम और आँकड़े',
  animals: 'जानवर, पक्षी, समुद्री जीव — क्षमताएँ और अनुकूलन',
  food: 'खाना, मसाले, फ़सलें, रसोई का विज्ञान',
  medicine: 'दवाइयाँ, टीके, बीमारियाँ, सर्जरी का इतिहास',
  language: 'भाषाएँ, लिपियाँ, शब्दों की जड़ें',
  sports: 'खेल, रिकॉर्ड, खिलाड़ी आँकड़े, खेल का विज्ञान',
  weather: 'मौसम, तूफ़ान, बारिश, बिजली, पूर्वानुमान कैसे काम करता है',
  plants: 'पेड़, जंगल, फूल, बीज, प्रकाश संश्लेषण',
  transport: 'रेल, हवाई जहाज़, जहाज़, सड़क, इंजन',
  india: 'भारत के तथ्य — नक्शा, रिकॉर्ड, संस्कृति, निर्माण, रेलवे',
  buildings: 'इमारतें, पुल, बाँध, सुरंगें, वास्तुकला के आँकड़े',

  markets: 'शेयर बाज़ार कैसे काम करता है — निवेशक, ब्रोकर, एक्सचेंज, ट्रेडिंग और डीमैट खाते, सूचकांक और ऐतिहासिक घटनाएँ. कोई खरीद/बिक्री सलाह नहीं.',
  money: 'पैसे का इतिहास — नोट, सिक्के, मुद्रास्फीति, UPI, नक़ली नोट',
  economy: 'GDP, रोज़गार, आयात-निर्यात, भारत की अर्थव्यवस्था',
  business: 'कंपनियाँ कैसे बनीं और गिरीं, ब्रांड की कहानियाँ',
  banking: 'बैंक, ब्याज, RBI, चक्रवृद्धि, लोन और EMI का गणित',
  tax: 'टैक्स कैसे लगता है, GST, इतिहास, दुनिया की अजीब टैक्स कहानियाँ',
  insurance: 'बीमा कैसे काम करता है, जोखिम का गणित, क्लेम आँकड़े',
  scams: 'मशहूर वित्तीय घोटाले — कैसे हुए, कैसे पकड़े गए, कैसे बचें',
};

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
  if (hour < 6) return 'morning';
  if (hour < 11) return 'midday';
  return 'evening';
}

export function categoryFor(date = new Date(), slot = 'evening') {
  if (slot === 'evening') {
    return FINANCE[dayNumber(date) % FINANCE.length];
  }

  const index = SLOTS.indexOf(slot);
  if (index === -1) throw new Error(`Unknown slot "${slot}" — ${SLOTS.join(' or ')}.`);
  return POOL[(dayNumber(date) * STRIDE + index * SLOT_OFFSET) % POOL.length];
}
