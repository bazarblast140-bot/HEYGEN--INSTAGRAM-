// The prompt for the midday technology carousel.
//
// It differs from the facts prompt in one way that matters more than all the
// formatting: the model is not asked what happened today. It is TOLD what
// happened today, and forbidden from adding anything else.
//
// That inversion is the point. A model asked for news writes news -- fluent,
// specific, and made up, because it has no way of knowing it is out of date.
// Here the stories arrive from Hacker News with their titles, sites and dates,
// and the model translates and explains. If a fact is not in the list, it does
// not go on a slide.

export const SYSTEM = `तुम "FACTVIZER" के लिए रोज़ दोपहर का technology carousel लिखते हो — Instagram पर 6 slides की एक Hindi post.

कड़े नियम, महत्व के क्रम में:
1. सिर्फ़ वही लिखो जो नीचे दी गयी ख़बरों में है. अपनी याददाश्त से कोई ख़बर, नंबर, तारीख़ या कंपनी मत जोड़ो — तुम्हारी जानकारी पुरानी है, ये सूची आज की है.
2. किसी ख़बर का मतलब समझ न आए तो उसे छोड़ दो. पाँच में से तीन ख़बरें काफ़ी हैं.
3. हर fact slide पर स्रोत उसी site का नाम हो जो सूची में दिया है.
4. शुद्ध हिंदी में लिखो, देवनागरी में. तकनीकी नाम अंग्रेज़ी में ही रहने दो — GPT, Linux, GPU, Nvidia — उनका अनुवाद मत करो.
5. Slide पर text छोटा हो: headline 4 शब्द तक, subline दो पंक्तियों में.

लहजा: सीधा और साफ़. तुम एक ऐसे पाठक को समझा रहे हो जो होशियार है पर इस क्षेत्र में नया है — hype नहीं, "क्रांति" नहीं, बस ये हुआ और इससे फ़र्क़ क्या पड़ता है.`;

export function buildUserPrompt({ stories, date, recentTopics = [] }) {
  const list = stories
    .map((s, i) => `${i + 1}. ${s.title}\n   स्रोत: ${s.site}  ·  तारीख़: ${s.date}  ·  ${s.points} points`)
    .join('\n');

  const alreadyCovered = recentTopics.length
    ? `\n\n<already_covered>
पिछली posts इन विषयों पर थीं. आज इनसे अलग चुनो.

${recentTopics.map((t) => `- ${t.date}: ${t.topic}`).join('\n')}
</already_covered>`
    : '';

  return `<task>
आज (${date}) का technology carousel लिखो.

नीचे आज की असली ख़बरें हैं. इन्हीं में से 3 से 4 चुनो — जो सबसे ज़्यादा मायने
रखती हैं, जिन्हें आम पाठक को समझाया जा सके. बाक़ी छोड़ दो.
</task>

<stories>
${list}
</stories>${alreadyCovered}

<structure>
ठीक 6 slides, इसी क्रम में:

  1. cover — एक सवाल या एक पंक्ति जो पढ़ने वाले को रोक दे. band "center". कोई स्रोत नहीं.
  2-5. चार slides. band "bottom". हर एक पर स्रोत ज़रूरी — उसी site का नाम.
  6. follow card — cta true. band "bottom". कोई स्रोत नहीं.

Slide 2 पर सबसे बड़ी ख़बर रखो. Instagram पर ज़्यादातर लोग तीसरी slide तक ही जाते हैं.
</structure>

<output_format>
सिर्फ़ JSON लौटाओ. कोई भूमिका नहीं, कोई markdown fence नहीं.

{
  "topic": "आज का विषय 3 से 7 शब्दों में",
  "category": "technology",
  "slides": [
    {
      "band": "center",
      "headline": "सवाल, दो पंक्तियों में, बीच में \\n",
      "subline": null,
      "source": null,
      "cta": false,
      "query": "english search words for a photo"
    },
    {
      "band": "bottom",
      "headline": "4 शब्द तक",
      "subline": "क्या हुआ, दो पंक्तियों में\\nबीच में \\n",
      "source": "site का नाम",
      "cta": false,
      "query": "english search words for a photo"
    }
  ],
  "caption": "पहली पंक्ति: सबसे बड़ी ख़बर, 125 अक्षर से कम. फिर 2 से 3 वाक्य.",
  "hashtags": ["#टेक्नोलॉजी", "#एआई", "#ai", "#technews"]
}

fields:
  headline  — 4 शब्द तक. चीज़ या कंपनी का नाम, नारा नहीं.
  subline   — cover पर null. बाक़ी पर ख़बर, ठीक दो पंक्तियों में.
  source    — cover और cta पर null. बाक़ी हर slide पर सूची वाली site.
  query     — हमेशा अंग्रेज़ी में, 2 से 4 शब्द. एक असली दृश्य लिखो जिसकी तस्वीर
              खींची जा सकती हो: "data center servers", "computer chip macro",
              "server room cables", "code on screen", "robot arm factory".
              कंपनी का नाम, mascot या logo कभी मत लिखो. "linux penguin" लिखोगे
              तो सचमुच पेंगुइन की तस्वीर आएगी — असली में यही हुआ था.
              Pexels हिंदी नहीं समझता, और वो अर्थ नहीं दृश्य ढूँढ़ता है.
  hashtags  — 8 से 15, कम से कम 3 हिंदी और 3 अंग्रेज़ी.
</output_format>

भेजने से पहले जाँचो: हर slide की बात ऊपर की सूची में मौजूद है, और कोई नाम या
नंबर तुमने ख़ुद से नहीं जोड़ा.`;
}
