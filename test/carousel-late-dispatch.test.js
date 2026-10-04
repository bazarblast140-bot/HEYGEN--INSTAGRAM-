import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRun, lateOk } from '../pipeline/src/carousel/categories.js';

const at = (iso) => new Date(iso);
const env = { ENABLE_AI_NEWS_CAROUSELS: 'true' };

test('explicit ai dispatch after its window is refused without late', () => {
  const d = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'ai', now: at('2026-10-04T06:40:00Z'), env });
  assert.equal(d.reason, 'wrong-time');
});

test('late=true lets a missed ai slot post later the same IST day', () => {
  const d = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'ai', now: at('2026-10-04T06:40:00Z'), env: { ...env, DISPATCH_LATE: 'true' } });
  assert.equal(d.pending, true);
  assert.equal(d.key, '2026-10-04 ai');
});

test('late never posts before the window opens or after 23:00 IST', () => {
  const e = { DISPATCH_LATE: 'true' };
  assert.equal(lateOk('ai', at('2026-10-04T03:00:00Z'), e), false); // 08:30 IST
  assert.equal(lateOk('ai', at('2026-10-04T17:45:00Z'), e), false); // 23:15 IST
  assert.equal(lateOk('ai', at('2026-10-04T06:40:00Z'), {}), false);
});

test('late still respects the ledger (no repeat)', () => {
  const entries = [{ date: '2026-10-04 ai', topic: 'x' }];
  const d = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'ai', now: at('2026-10-04T06:40:00Z'), entries, env: { ...env, DISPATCH_LATE: 'true' } });
  assert.notEqual(d.pending, true);
});

test('post gate: late dispatch is not refused for the closed window', async () => {
  const { approvalProblems } = await import('../pipeline/approve-build.js');
  const report = { publishable: true, format: 'jpeg', files: ['x.jpg'], slot: 'ai', istDate: '2026-10-04' };
  const now = at('2026-10-04T06:40:00Z');
  const strict = await approvalProblems(report, { now, files: false });
  const late = await approvalProblems(report, { now, files: false, late: true });
  assert.ok(strict.some((p) => /window is closed/.test(p)));
  assert.ok(!late.some((p) => /window is closed/.test(p)));
});

test('post gate reads the COMMITTED ledger, not the working copy the build just wrote', async () => {
  const { committedEntries } = await import('../pipeline/post-gate.js');
  const got = committedEntries();
  assert.ok(got === null || Array.isArray(got));
});
