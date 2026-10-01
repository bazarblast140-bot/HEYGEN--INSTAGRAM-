// Classify a failed Actions log and decide whether an automatic rerun is safe.
//
// Permanent request errors are recognised before the network patterns, so a
// DeepSeek HTTP 400 is not treated as a blip. Preview runs are never rerun.
// A log that already shows a published media id is never rerun: the ledger
// commit happens after publish, so a rerun of that job would post a second time
// if the commit had not landed yet.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function classifyFailure(log) {
  const text = String(log || '');
  const http4xx = text.match(/\bHTTP (4\d\d)\b/g) || [];
  const permanent4xx = http4xx.some((hit) => !/\bHTTP 429\b/.test(hit));
  if (permanent4xx || /\brequest problem\b/i.test(text) || /\binvalid\b/i.test(text) || /\bmust contain\b/i.test(text)) {
    return 'code_or_request';
  }
  if (/9007|Media ID not available|code.?9007|wait.*FINISHED/i.test(text)) return 'transient_ig_9007';
  if (/\b(ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|HTTP (429|502|503|504))\b/i.test(text)) return 'transient_network';
  if (/Only photo or video can be accepted|media type/i.test(text)) return 'transient_media_url';
  if (/SyntaxError|Unexpected token|is not valid JSON|Cannot find module/i.test(text)) return 'code_syntax';
  if (/normalizeSpec|validate.*fail|shape|2-cover|REFUSED/i.test(text)) return 'spec_validation';
  if (/token.*(expir|invalid)|OAuth|IG_ACCESS|instagram-doctor/i.test(text)) return 'auth_token';
  return 'unknown';
}

export function isPreviewRun({ event = '', title = '', inputs = null, log = '' } = {}) {
  const raw = inputs && typeof inputs === 'object' ? inputs.preview : inputs;
  if (raw === true || String(raw || '').toLowerCase() === 'true') return true;
  const blob = `${title}\n${log}`;
  return /\bpreview\s*[:=]\s*["']?true\b/i.test(blob) || /PREVIEW="true"/.test(blob);
}

/** The publish scripts print `published <id>` only after Instagram accepts the post. */
export function alreadyPublished(log) {
  const text = String(log || '').replace(/\x1b\[[0-9;]*m/g, '');
  return /\bpublished\b:?\s+\d{6,}/.test(text) || /\bstory \d+\/\d+ published\b/.test(text);
}

const TRANSIENT = new Set(['transient_ig_9007', 'transient_network', 'transient_media_url']);

export function rerunDecision({ kind, preview = false, log = '', attempt = 1, max = 2 } = {}) {
  if (preview) return { rerun: false, reason: 'preview' };
  if (alreadyPublished(log)) return { rerun: false, reason: 'already-published' };
  if (kind === 'code_or_request' || kind === 'code_syntax' || kind === 'spec_validation' || kind === 'auth_token') {
    return { rerun: false, reason: kind };
  }
  const n = Number(attempt) || 1;
  if (TRANSIENT.has(kind)) {
    return n < max ? { rerun: true, reason: kind } : { rerun: false, reason: 'exhausted' };
  }
  return n <= 1 ? { rerun: true, reason: 'unknown' } : { rerun: false, reason: 'unknown' };
}

function arg(name, argv) {
  const i = argv.indexOf(name);
  if (i === -1) return '';
  return argv[i + 1] || '';
}

function readInputs(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const argv = process.argv.slice(2);
  const logPath = arg('--log', argv);
  const log = logPath ? fs.readFileSync(logPath, 'utf8') : arg('--text', argv);
  const headPath = arg('--head-file', argv);
  const head = headPath ? fs.readFileSync(headPath, 'utf8') : arg('--head', argv);
  const inputs = readInputs(arg('--inputs', argv));
  const preview = isPreviewRun({
    event: arg('--event', argv),
    title: arg('--title', argv),
    inputs,
    log: `${head}\n${log}`,
  });
  const kind = classifyFailure(log);
  const decision = rerunDecision({
    kind,
    preview,
    log,
    attempt: Number(arg('--attempt', argv) || 1),
    max: Number(arg('--max', argv) || 2),
  });
  process.stdout.write(`${JSON.stringify({ kind, preview, ...decision })}\n`);
}
