import { SLIDES } from './categories.js';

export const SYSTEM = `तुम "Rajesh Technical Traders" के लिए एक Hindi Instagram carousel लिखते हो — ठीक ${SLIDES} slides.

कड़े नियम:
1. हर carousel एक ठोस बात सिखाए जो Indian retail trader या investor सेव कर सके: इस ख़बर का बाज़ार, पैसे, या भारतीय निवेशक पर क्या असर है.
2. सिर्फ़ वही तथ्य, संख्या और उद्धरण लिखो जो नीचे दी गई ख़बरों में हैं. याद से कुछ मत जोड़ो. ख़बर में न हो तो "पता नहीं" लिखो, संख्या मत गढ़ो.
3. हर fact slide पर स्रोत का नाम और प्रकाशन तारीख़ लिखो, जैसे "Reuters, 2026-10-01". Caption में भी वही स्रोत और तारीख़ हो.
4. शुद्ध हिंदी (देवनागरी). कंपनी और बाज़ार के नाम अंग्रेज़ी में रहने दो.
5. सलाह मत दो: buy, sell, hold, target नहीं.`;

export function buildSourcedPrompt({ kind, stories, date, recentTopics = [] }) {
  const subject = kind === 'ai'
    ? 'latest AI update'
    : 'latest big news';
  const angle = kind === 'ai'
    ? 'AI ख़बर को Indian investors के नज़रिए से समझाओ: IT stocks, tool cost, regulation, या productivity — जो ख़बर से निकलता हो. ख़बर में न हो तो असर को संख्या बनाए बिना समझाओ.'
    : 'ख़बर का finance angle निकालो: बाज़ार, रुपये, ब्याज, कंपनियों, या भारतीय निवेशकों पर असर. सिर्फ़ वही असर जो दी गई ख़बर से निकलता हो.';

  const list = stories.map((story, i) => (
    `${i + 1}. ${story.title}\n   स्रोत: ${story.site}  ·  तारीख़: ${story.date}\n   ${story.url || ''}`
  )).join('\n');

  const already = recentTopics.length
    ? `\n<already_covered>\n${recentTopics.map((t) => `- ${t.date}: ${t.topic}`).join('\n')}\n</already_covered>\n`
    : '';

  return `<task>
आज (${date}) का ${subject} carousel. ${angle}
नीचे सिर्फ़ वे ख़बरें हैं जो build के समय fetch हुईं और 48 घंटे से नई हैं. इनमें से चुनो. कोई और घटना मत लिखो.
</task>
${already}
<stories>
${list}
</stories>

<structure>
ठीक ${SLIDES} slides.
  1. cover — band "center", curiosity hook, स्रोत नहीं
  2-${SLIDES - 1}. fact slides — band "bottom", source में नाम और तारीख़
  ${SLIDES}. follow card — cta true, source null
आख़िरी fact slide पर स्रोत ज़रूर हो. Caption की एक पंक्ति "स्रोत: नाम, YYYY-MM-DD" हो.
</structure>`;
}
