// A slide that says the same thing twice.
//
// The template gives each fact slide a headline and a line under it, and the
// model kept filling both with the same sentence:
//
//   12TB गेमिंग इतिहास लीक
//   Steam का डेटा लीक: दशकों के खोए PC गेम्स मिले
//
//   California में Linux को छूट
//   उम्र सत्यापन कानून से Linux को मिली छूट, सर्वसम्मति से पारित
//
// Two lines, one fact, and the reader gets nothing for reading the second. The
// headline is meant to NAME the thing; the line under it is meant to say what
// happened to it, or what the number is.
//
// This cannot be repaired in code -- there is no way to invent the missing
// half -- so it is one of the few faults that is handed back to the model.

// Words too common to prove anything by matching. Hindi first, since that is
// what the slides are written in.
const NOISE = new Set([
  'का', 'की', 'के', 'को', 'में', 'से', 'पर', 'और', 'है', 'हैं', 'था', 'थे', 'हुआ', 'हुई',
  'यह', 'वह', 'ये', 'वो', 'एक', 'भी', 'ही', 'तक', 'लिए', 'साथ', 'बाद', 'रहा', 'रही',
  'नया', 'नई', 'बड़ा', 'बड़ी', 'सबसे', 'अब', 'फिर',
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'is', 'are', 'was', 'new',
]);

export function meaningful(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NOISE.has(w));
}

/**
 * True when the second line mostly repeats the first.
 *
 * Most of the words, not all of them: requiring all was tried against the two
 * slides that went out and caught neither, because each carried one word the
 * other lacked. "Linux को छूट" over "Linux को मिली छूट, सर्वसम्मति से पारित"
 * shares two of three and is the same sentence twice; "शुक्र" over "अपनी धुरी
 * पर एक चक्कर 243 दिन" shares nothing and is a name over a fact.
 *
 * Two shared words are required as well as the share, so a two-word headline
 * cannot trip on a single common word.
 *
 * What this cannot see: a headline and a line that repeat each other's MEANING
 * in different words -- "12TB गेमिंग इतिहास लीक" over "Steam का डेटा लीक:
 * दशकों के खोए PC गेम्स मिले". No word test reaches that. The prompt is what
 * has to prevent it.
 */
export const SHARE = 0.6;

export function echoes(headline, subline, share = SHARE) {
  const head = meaningful(headline);
  const body = new Set(meaningful(subline));
  if (head.length < 2 || !body.size) return false;   // a one-word name is a name

  const shared = head.filter((w) => body.has(w)).length;
  return shared >= 2 && shared / head.length >= share;
}

/** Slides whose two lines say one thing. */
export function checkEcho(spec) {
  return (spec.slides || []).flatMap((slide, i) => {
    if (slide.band === 'center' || slide.cta || !slide.subline) return [];
    if (!echoes(slide.headline, slide.subline)) return [];
    return [`slide ${i + 1}: "${slide.headline}" is said again in the line below it — `
      + 'the headline names the thing, the line under it says what happened or what the number is'];
  });
}
