// Which subject is this, and what should it look like.
//
// "Har bar new topic ho" was solved by the topic ledger, and the reels still all
// looked the same — a new subject arrived every morning wearing yesterday's
// clothes. The ledger changes the words; this changes the picture.
//
// A family is chosen once, by the model writing the script, and everything
// visual follows from it. Nobody picks a motif by hand on a Tuesday morning.
//
// The palette never changes. Navy and amber are the brand, and a reel that
// changed colour by subject would stop looking like Rajesh's. What changes is
// the texture behind the type — enough that two mornings do not look like one.

export const FAMILIES = {
  market: {
    label: 'index levels, a session, F I I flows, a single stock move',
    motif: 'dots',
    hint: 'the ambient field the market beats have always used',
  },
  ai: {
    label: 'A I, semiconductors, data centres, technology stocks',
    motif: 'nodes',
    hint: 'a lattice with signals running along its edges',
  },
  fund: {
    label: 'mutual funds, S I P flows, A M C s, retail participation',
    motif: 'flow',
    hint: 'streaks rising and fading — money moving, with direction',
  },
  policy: {
    label: 'R B I, S E B I, budget, tax, government decisions',
    motif: 'ledger',
    hint: 'ruled paper with a turning seal — a document, as texture',
  },
  commodity: {
    label: 'gold, silver, crude, currency',
    // No motif of its own yet; the ambient field carries it until one exists.
    motif: 'dots',
    hint: 'falls back to the ambient field for now',
  },
};

export const FAMILY_NAMES = Object.keys(FAMILIES);

/** Never let an unknown family blank the background. */
export function motifFor(family) {
  return FAMILIES[family]?.motif || 'dots';
}

/** The menu the script model chooses from, written out for the prompt. */
export function familyMenu() {
  return FAMILY_NAMES.map((k) => `  "${k}" — ${FAMILIES[k].label}`).join('\n');
}
