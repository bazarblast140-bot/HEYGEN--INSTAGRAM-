// Today's technology and AI stories, fetched rather than remembered.
//
// This is the whole reason the midday post is built differently from the other
// two. A language model has a training cutoff and no browser: ask it for "aaj
// ki AI news" and it will write something confident, plausible and either
// months old or invented outright. On an account whose promise is that the
// facts are checkable, that is the worst possible failure -- it looks exactly
// like the good posts.
//
// So the stories arrive from outside, with their real titles, real links and
// real dates, and the model's only job is to explain them in Hindi. It cannot
// invent a story it was never given.
//
// Two sources, because one was the wrong shape.
//
//   Google News, India edition. Free, no key, and it is where the news a Hindi
//   reader would call "AI news" actually is -- OpenAI, Google, Nvidia, Indian
//   tech policy. Each item carries its publisher's own name, which is what a
//   slide cites.
//
//   Hacker News. Free, no key, and where a story often surfaces first, with
//   points as a crude but real quality signal. On its own it is too narrow for
//   this account: the first live build led with Debian's AI policy, which is a
//   genuine story and not one anybody outside engineering is waiting for.
//
// Merged, de-duplicated, and a story both of them carry ranks highest -- two
// unrelated crowds finding the same thing interesting is the strongest signal
// available for free.

const HN = 'https://hn.algolia.com/api/v1/search';
const GOOGLE = 'https://news.google.com/rss/search';

/** What the midday post is about, asked of Google News in its own words. */
export const QUERIES = [
  'artificial intelligence',
  'AI technology India',
  'technology innovation',
];

/**
 * Words that make a story about technology rather than about a company's share
 * price or somebody's blog redesign. Matched against the title, because the
 * title is all the API gives that is worth matching on.
 */
const ON_TOPIC = /\b(ai|llm|gpt|claude|gemini|llama|model|neural|robot|chip|gpu|semiconductor|quantum|open[- ]?source|algorithm|dataset|training|inference|agent|rust|linux|kernel|browser|encryption|satellite|battery|solar|fusion|biotech|genome|space|rocket)\b/i;

/** Stories that are noise on a facts account whatever their score. */
const OFF_TOPIC = /\b(hiring|who is hiring|ask hn|show hn|layoffs?|lawsuit|acquired|funding round|series [a-e]\b|ipo|stock|shares|earnings|obituary|died|passed away)\b/i;

const domain = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
};

/**
 * The most discussed technology stories of the last `hours`.
 *
 * Sorted by points rather than recency: the newest story is usually the least
 * examined one, and a post built on it can be repeating a claim that was
 * corrected two hours later.
 */
export async function fetchHackerNews({ hours = 36, limit = 12, minPoints = 30 } = {}) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const url = new URL(HN);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('numericFilters', `created_at_i>${since},points>${minPoints}`);
  url.searchParams.set('hitsPerPage', '100');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hacker News ${res.status}`);
  const { hits = [] } = await res.json();

  return hits
    .filter((h) => h.title && h.url)
    .filter((h) => ON_TOPIC.test(h.title) && !OFF_TOPIC.test(h.title))
    .map((h) => ({
      title: h.title,
      url: h.url,
      site: domain(h.url),
      points: h.points,
      date: (h.created_at || '').slice(0, 10),
      at: Date.parse(h.created_at || 0),
      from: 'Hacker News',
    }))
    .filter((s) => s.site)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

export { ON_TOPIC, OFF_TOPIC };


/**
 * Google News gives RSS, and RSS is XML, and this repository has no XML parser.
 *
 * It also does not need one. The feed is machine-generated and flat: a list of
 * <item> blocks with four fields each. Pulling those out with a regex would be
 * a bad idea against arbitrary XML and is a fine one against a feed whose shape
 * is fixed -- and it keeps a dependency out of a pipeline that runs unattended.
 *
 * The link is a Google redirect, so the publisher must come from the <source>
 * element. That name -- "Reuters", "The Verge" -- is what a slide cites, and it
 * is more use to a reader than news.google.com would be.
 */
export function parseRss(xml) {
  const items = String(xml).match(/<item>[\s\S]*?<\/item>/g) || [];
  const field = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    if (!m) return null;
    return m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
  };

  return items.map((block) => {
    const site = field(block, 'source');
    // Google appends " - Publisher" to every headline. The publisher is already
    // a field of its own, and on a slide the repetition is just noise.
    const title = (field(block, 'title') || '').replace(new RegExp(`\\s+[-–|]\\s*${site ? site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '$^'}\\s*$`), '');
    const published = field(block, 'pubDate');
    return {
      title,
      url: field(block, 'link'),
      site,
      date: published ? new Date(published).toISOString().slice(0, 10) : null,
      at: published ? Date.parse(published) : 0,
    };
  }).filter((s) => s.title && s.site);
}

async function fetchGoogleNews({ query, hours = 36, limit = 12 }) {
  const url = new URL(GOOGLE);
  url.searchParams.set('q', `${query} when:2d`);
  url.searchParams.set('hl', 'en-IN');
  url.searchParams.set('gl', 'IN');
  url.searchParams.set('ceid', 'IN:en');

  const res = await fetch(url, { headers: { 'User-Agent': 'factvizer-carousel/1.0' } });
  if (!res.ok) throw new Error(`Google News ${res.status}`);

  const cutoff = Date.now() - hours * 3600 * 1000;
  return parseRss(await res.text())
    .filter((s) => s.at >= cutoff)
    .filter((s) => !OFF_TOPIC.test(s.title))
    .map((s) => ({ ...s, from: 'Google News' }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/** Same story, differently worded, from two places. */
const fingerprint = (title) => String(title).toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  .filter((w) => w.length > 3).sort().slice(0, 8).join(' ');

/**
 * Today's stories, mainstream first, with anything both sources carry on top.
 *
 * Never throws on one source failing: Google News is not a documented API and
 * Hacker News is a small volunteer service. Losing one is a thinner list, not a
 * missed post -- losing both is, and that is reported honestly rather than
 * papered over with whatever the model remembers.
 */
export async function fetchStories({ hours = 36, limit = 12, onNote } = {}) {
  const jobs = [
    ...QUERIES.map((query) => ({ label: `Google News "${query}"`, run: () => fetchGoogleNews({ query, hours }) })),
    { label: 'Hacker News', run: () => fetchHackerNews({ hours }) },
  ];
  const results = await Promise.allSettled(jobs.map((j) => j.run()));

  // Say what each source did. A source that quietly returns nothing looks
  // exactly like a source that is switched off, and Google News did precisely
  // that for two runs while the log showed a healthy-looking build.
  results.forEach((r, i) => {
    onNote?.(r.status === 'fulfilled'
      ? `${jobs[i].label}: ${r.value.length} stories`
      : `${jobs[i].label}: FAILED — ${String(r.reason?.message).slice(0, 80)}`);
  });

  const seen = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const story of result.value) {
      const key = fingerprint(story.title);
      const already = seen.get(key);
      // A story both crowds carry is the one worth leading with.
      if (already) already.corroborated = true;
      else seen.set(key, { ...story, corroborated: false });
    }
  }

  const all = [...seen.values()];
  const corroborated = all.filter((s) => s.corroborated);

  // Interleave the two sources rather than sorting them together.
  //
  // Sorting by points looked right and buried Google News entirely: a Hacker
  // News story carries a score and a news item does not, so every mainstream
  // headline sank below every forum post and the run came back with the same
  // engineering stories the second source was added to balance. Ranking across
  // two scales that do not exist in both is not ranking, it is a coin toss with
  // one side weighted.
  const queue = {
    'Google News': all.filter((s) => !s.corroborated && s.from === 'Google News').sort((a, b) => b.at - a.at),
    'Hacker News': all.filter((s) => !s.corroborated && s.from === 'Hacker News').sort((a, b) => b.points - a.points),
  };

  const mixed = [];
  while (mixed.length + corroborated.length < limit && (queue['Google News'].length || queue['Hacker News'].length)) {
    // Mainstream first on each pass: it is what a reader means by "AI news".
    for (const source of ['Google News', 'Hacker News']) {
      const next = queue[source].shift();
      if (next) mixed.push(next);
    }
  }

  return [...corroborated, ...mixed].slice(0, limit);
}
