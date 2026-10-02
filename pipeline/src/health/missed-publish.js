// Open or update one health-alert issue when an enabled slot is still
// unpublished 30 minutes after its time, and close that issue once the slot
// has a successful publish. Disabled AI/news slots are not checked.

import { istParts, inWindow } from '../carousel/categories.js';
import { flagOn, ENABLE_AI_NEWS_CAROUSELS } from '../publish/flags.js';
import { istDate, isCarouselMedia, resolveReelPublish } from '../publish/same-day.js';

export const GRACE_MINUTES = 30;
export const ALERT_LABEL = 'health-alert';

export const SLOT_TIMES = {
  reel: { label: 'Reel', ist: '07:00', minute: 7 * 60 },
  ai: { label: 'AI carousel', ist: '09:30', minute: 9 * 60 + 30 },
  midday: { label: 'Midday carousel', ist: '12:30', minute: 12 * 60 + 30 },
  news: { label: 'News carousel', ist: '16:30', minute: 16 * 60 + 30 },
  evening: { label: 'Evening carousel', ist: '19:30', minute: 19 * 60 + 30 },
};

export function alertTitle(date) {
  return `Scheduled post missing (${date})`;
}

export function enabledPublishSlots(env = process.env) {
  const slots = ['reel', 'midday', 'evening'];
  if (flagOn(ENABLE_AI_NEWS_CAROUSELS, env)) slots.splice(1, 0, 'ai');
  if (flagOn(ENABLE_AI_NEWS_CAROUSELS, env)) slots.splice(slots.indexOf('evening'), 0, 'news');
  return slots;
}

function carouselPublished({ slot, date, carouselEntries = [], media = [] }) {
  const key = `${date} ${slot}`;
  if ((carouselEntries || []).some((entry) => entry?.date === key)) return true;
  return (media || []).some((item) => {
    if (!isCarouselMedia(item) || !item.timestamp) return false;
    const when = new Date(item.timestamp);
    if (Number.isNaN(when.getTime())) return false;
    return istDate(when) === date && inWindow(slot, when);
  });
}

export function missedSlots({
  now = new Date(),
  env = process.env,
  reelPublishEntries = [],
  carouselEntries = [],
  media = [],
} = {}) {
  const { date, minutes } = istParts(now);
  const missed = [];
  for (const slot of enabledPublishSlots(env)) {
    if (minutes < SLOT_TIMES[slot].minute + GRACE_MINUTES) continue;
    if (slot === 'reel') {
      const decision = resolveReelPublish({ now, publishEntries: reelPublishEntries, media });
      if (!decision.pending) continue;
    } else if (carouselPublished({ slot, date, carouselEntries, media })) {
      continue;
    }
    missed.push(slot);
  }
  return missed;
}

export function alertBody(date, missed) {
  const lines = missed.map((slot) => `- ${SLOT_TIMES[slot].label} (${SLOT_TIMES[slot].ist} IST)`);
  return [
    `No successful publish by 30 minutes after the slot time on ${date} (IST).`,
    '',
    ...lines,
    '',
    'This issue closes once each listed slot has a publish record or Instagram media for this date.',
  ].join('\n');
}

export function alertPlan({ date, missed = [], openIssues = [] } = {}) {
  const title = alertTitle(date);
  const ours = (openIssues || []).filter((issue) => issue.title === title && issue.state !== 'closed');
  if (!missed.length) {
    if (!ours.length) return { action: 'none', title, date };
    return { action: 'close', title, date, numbers: ours.map((issue) => issue.number) };
  }
  const body = alertBody(date, missed);
  if (!ours.length) {
    return { action: 'open', title, date, body, labels: [ALERT_LABEL] };
  }
  return {
    action: 'update',
    title,
    date,
    body,
    number: ours[0].number,
    closeExtras: ours.slice(1).map((issue) => issue.number),
  };
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'slot-health',
    'Content-Type': 'application/json',
  };
}

async function gh(fetcher, url, token, method, body) {
  const res = await fetcher(url, {
    method,
    headers: ghHeaders(token),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let payload = {};
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { message: text.slice(0, 200) }; }
  }
  return { ok: res.ok, status: res.status, payload };
}

export async function applyAlertPlan({
  plan,
  repo,
  token,
  fetcher = globalThis.fetch,
} = {}) {
  if (!plan || plan.action === 'none') return { ok: true, action: 'none' };
  if (!repo || !token) {
    throw new Error(`cannot ${plan.action} the health-alert issue without GITHUB_TOKEN and a repository`);
  }
  const base = `https://api.github.com/repos/${repo}`;

  if (plan.action === 'open') {
    await gh(fetcher, `${base}/labels`, token, 'POST', {
      name: ALERT_LABEL,
      color: 'b60205',
      description: 'A scheduled Reel or carousel did not publish',
    });
    const created = await gh(fetcher, `${base}/issues`, token, 'POST', {
      title: plan.title,
      body: plan.body,
      labels: plan.labels,
    });
    if (!created.ok) {
      throw new Error(`opening the health-alert issue failed (${created.status})`);
    }
    return { ok: true, action: 'open', number: created.payload.number };
  }

  if (plan.action === 'update') {
    const updated = await gh(fetcher, `${base}/issues/${plan.number}`, token, 'PATCH', {
      title: plan.title,
      body: plan.body,
    });
    if (!updated.ok) throw new Error(`updating the health-alert issue failed (${updated.status})`);
    for (const number of plan.closeExtras || []) {
      await gh(fetcher, `${base}/issues/${number}`, token, 'PATCH', {
        state: 'closed',
        state_reason: 'completed',
      });
    }
    return { ok: true, action: 'update', number: plan.number };
  }

  if (plan.action === 'close') {
    for (const number of plan.numbers || []) {
      const closed = await gh(fetcher, `${base}/issues/${number}`, token, 'PATCH', {
        state: 'closed',
        state_reason: 'completed',
      });
      if (!closed.ok) throw new Error(`closing health-alert #${number} failed (${closed.status})`);
    }
    return { ok: true, action: 'close', numbers: plan.numbers };
  }

  return { ok: true, action: plan.action };
}

export async function listOpenAlerts({ repo, token, fetcher = globalThis.fetch } = {}) {
  if (!repo || !token) return [];
  const url = `https://api.github.com/repos/${repo}/issues?labels=${encodeURIComponent(ALERT_LABEL)}&state=open&per_page=20`;
  const listed = await gh(fetcher, url, token, 'GET');
  if (!listed.ok) throw new Error(`listing health-alert issues failed (${listed.status})`);
  const issues = Array.isArray(listed.payload) ? listed.payload : [];
  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
  }));
}
