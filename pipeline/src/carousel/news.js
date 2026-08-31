// Today's technology and AI stories, fetched rather than remembered.
//
// This is the whole reason the midday post is built differently from the other
// two. A language model has a training cutoff and no browser: ask it for "aaj
// ki AI news" and it will write something confident, plausible and either
// months old or invented outright. On an account whose promise is that the
// facts are checkable, that is the worst possible failure -- it looks exactly
// like the good posts.
//
// So the stories arrive from outside, with their real titles, real publishers
// and real dates, and the model's only job is to explain them in Hindi. It
// cannot invent a story it was never given.
//
// Twelve sources, none of which needs a key or an account:
//
//   The AI publications themselves -- OpenAI, Google, Hugging Face -- which is
//   where a launch is announced rather than reported.
//   The trade press -- The Verge, TechCrunch, MIT Technology Review,
//   VentureBeat, Ars Technica, MarkTechPost -- which explains what a launch
//   means.
//   arXiv cs.AI, for the research that becomes news a month later.
//   Google News (India edition), for the Indian angle and for anything the
//   English-language trade press covers late.
//   Hacker News, which surfaces a story early and scores it.
//
// No single source decides the post. They are interleaved one at a time, so a
// feed that publishes forty items a day cannot crowd out one that publishes
// two, and a story that appears in more than one place leads.

/**
 * Order matters: it is the round-robin order, so the first entries get the
 * first slides. Announcements first, then the press that explains them, then
 * the long tail.
 */
export const FEEDS = [
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/' },
  { name: 'VentureBeat', url: 'https://venturebeat.com/category/ai/feed/' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
  { name: 'MarkTechPost', url: 'https://www.marktechpost.com/feed/' },
  { name: 'arXiv cs.AI', url: 'https://rss.arxiv.org/rss/cs.AI' },
];

const HN = 'https://hn.algolia.com/api/v1/search';
const GOOGLE = 'https://news.google.com/rss/search';

/** What to ask Google News, in its own words. */
export const QUERIES = ['artificial intelligence', 'AI technology India'];

/**
 * Words that make a story about technology rather than about a share price.
 * Only Hacker News needs this -- every other source is already on topic.
 */
const ON_TOPIC = /\b(ai|llm|gpt|claude|gemini|llama|model|neural|robot|chip|gpu|semiconductor|quantum|open[- ]?source|algorithm|dataset|training|inference|agent|rust|linux|kernel|browser|encryption|satellite|battery|solar|fusion|biotech|genome|space|rocket)\b/i;

/** Noise on a facts account whatever its source. */
const OFF_TOPIC = /\b(hiring|who is hiring|ask hn|show hn|layoffs?|lawsuit|funding round|series [a-e]\b|ipo|stock|shares|earnings|obituary|died|passed away|deals?|discount|coupon|sale ends|best .* under)\b/i;

const domain = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
};

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ')
  .trim();

/**
 * One parser for both feed dialects, because this list is half of each.
 *
 * RSS wraps items in <item> and puts the URL in <link>text</link>; Atom wraps
 * them in <entry> and puts it in <link href="..."/>. Dates differ too --
 * pubDate against published or updated. Handling both here is a dozen lines;
 * handling one and discovering the other at 13:07 is a missed post.
 *
 * A regex is the wrong tool for arbitrary XML and the right one for a
 * machine-generated feed, and it keeps a dependency out of a pipeline that runs
 * unattended.
 */
export function parseRss(xml, { site } = {}) {
  const blocks = String(xml).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)
    || String(xml).match(/<(item|entry)>[\s\S]*?<\/\1>/g)
    || [];

  return blocks.map((block) => {
    const tag = (name) => {
      const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
      return m ? decode(m[1]) : null;
    };

    // Atom puts the URL in an attribute; RSS puts it in the element's text.
    const href = block.match(/<link[^>]*href=["']([^"']+)["']/);
    const url = href ? href[1] : tag('link');

    const published = tag('pubDate') || tag('published') || tag('updated') || tag('dc:date');
    const at = published ? Date.parse(published) : 0;

    const publisher = site || tag('source') || domain(url);

    // Google News appends " - Publisher" to every headline. The publisher is
    // already a field of its own, and on a slide the repetition is noise.
    const title = String(tag('title') || '')
      .replace(/\s+[-–|]\s*$/, '')
      .replace(publisher ? new RegExp(`\\s+[-–|]\\s*${publisher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) : /$^/, '')
      .trim();

    return {
      title,
      url,
      // The feed's own <source> is only present on Google News; everywhere else
      // the publisher is the feed itself, and that name is what a slide cites.
      site: publisher,
      date: Number.isFinite(at) && at ? new Date(at).toISOString().slice(0, 10) : null,
      at: Number.isFinite(at) ? at : 0,
    };
  }).filter((s) => s.title && s.site);
}

/** Eight seconds, then give up on this one. A slow feed must not hold the post. */
async function text(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'factvizer-carousel/1.0', ...headers },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.text();
}

async function fetchFeed({ name, url, hours, limit = 6 }) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  return parseRss(await text(url), { site: name })
    .filter((s) => s.at >= cutoff)
    .filter((s) => !OFF_TOPIC.test(s.title))
    .map((s) => ({ ...s, from: name }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

async function fetchGoogleNews({ query, hours, limit = 8 }) {
  const url = new URL(GOOGLE);
  url.searchParams.set('q', `${query} when:2d`);
  url.searchParams.set('hl', 'en-IN');
  url.searchParams.set('gl', 'IN');
  url.searchParams.set('ceid', 'IN:en');

  const cutoff = Date.now() - hours * 3600 * 1000;
  return parseRss(await text(url.href))
    .filter((s) => s.at >= cutoff)
    .filter((s) => !OFF_TOPIC.test(s.title))
    .map((s) => ({ ...s, from: 'Google News' }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

export async function fetchHackerNews({ hours = 36, limit = 8, minPoints = 30 } = {}) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const url = new URL(HN);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('numericFilters', `created_at_i>${since},points>${minPoints}`);
  url.searchParams.set('hitsPerPage', '100');

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
      at: Date.parse(h.created_at || 0) || 0,
      from: 'Hacker News',
    }))
    .filter((s) => s.site)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

/** Same story, differently worded, from two places. */
const fingerprint = (title) => String(title).toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  .filter((w) => w.length > 3).sort().slice(0, 8).join(' ');

/**
 * Today's stories: anything corroborated first, then one from each source in
 * turn.
 *
 * Round-robin rather than a single ranking, and that is a correction. Sorting
 * everything together by points buried Google News entirely, because only
 * Hacker News items have points -- ranking across a scale that exists in one
 * list is not ranking. Taking one from each source in turn needs no shared
 * scale, and it also stops a feed that publishes forty items a day from
 * crowding out one that publishes two.
 *
 * A source failing is never fatal here. One down is a thinner list; all down is
 * a missed post, which generateNewsCarousel reports rather than papering over
 * with whatever the model remembers.
 */
export async function fetchStories({ hours = 36, limit = 12, onNote } = {}) {
  const jobs = [
    ...FEEDS.map((feed) => ({ label: feed.name, run: () => fetchFeed({ ...feed, hours }) })),
    ...QUERIES.map((query) => ({ label: `Google News "${query}"`, run: () => fetchGoogleNews({ query, hours }) })),
    { label: 'Hacker News', run: () => fetchHackerNews({ hours }) },
  ];

  const results = await Promise.allSettled(jobs.map((j) => j.run()));

  // Say what each source did. A source that quietly returns nothing looks
  // exactly like a source that is switched off, and Google News did precisely
  // that for two runs while the log showed a healthy-looking build.
  const quiet = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') onNote?.(`${jobs[i].label}: FAILED — ${String(r.reason?.message).slice(0, 70)}`);
    else if (!r.value.length) quiet.push(jobs[i].label);
  });
  if (quiet.length) onNote?.(`nothing new from: ${quiet.join(', ')}`);

  const seen = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const story of r.value) {
      const key = fingerprint(story.title);
      const already = seen.get(key);
      if (already) already.corroborated = true;
      else seen.set(key, { ...story, corroborated: false });
    }
  }

  const all = [...seen.values()];
  const corroborated = all.filter((s) => s.corroborated);

  const queues = jobs.map((j) => all.filter((s) => !s.corroborated && s.from === j.label.replace(/^Google News.*/, 'Google News')));
  const mixed = [];
  while (mixed.length + corroborated.length < limit && queues.some((q) => q.length)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) mixed.push(next);
    }
  }

  const stories = [...corroborated, ...mixed].slice(0, limit);
  onNote?.(`${stories.length} stories from ${new Set(stories.map((s) => s.from)).size} sources`);
  return stories;
}

export { ON_TOPIC, OFF_TOPIC };
