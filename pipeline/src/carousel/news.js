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
// Hacker News' search API is the source: free, no key, no account, and it is
// where this kind of story surfaces first. Points are a crude quality signal
// but a real one -- a story a few thousand engineers upvoted today is more
// likely to matter than the top result for a keyword.

const API = 'https://hn.algolia.com/api/v1/search';

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
export async function fetchStories({ hours = 36, limit = 12, minPoints = 30 } = {}) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const url = new URL(API);
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
      comments: h.num_comments,
    }))
    .filter((s) => s.site)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

export { ON_TOPIC, OFF_TOPIC };
