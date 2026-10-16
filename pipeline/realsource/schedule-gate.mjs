// When a (late or early) scheduled midday run fires, decide: run now, wait, or skip.
// GitHub delays this repo's cron events by ~4.5-6.5 h (15 Oct: 07:00Z fired 12:32Z), so
// several early staggered crons are scheduled; whichever arrives first near 12:00 IST builds,
// the rest see today's package and skip. Usage: node schedule-gate.mjs <IST HH:MM> <built 0|1>
export const START = 12 * 60 + 5;      // midday gate opens 12:00 IST; articles need to be today's
export const LAST = 16 * 60 + 30;      // later than this there is no time to review + publish by 17:00
export const MAX_WAIT = 120;           // minutes a run may sleep (job timeout covers it)
export function decide(hhmm, built) {
  const [h, m] = hhmm.split(':').map(Number), now = h * 60 + m;
  if (built) return { action: 'skip', why: "today's midday package was already built by another run" };
  if (now >= LAST) return { action: 'skip', why: `fired at ${hhmm} IST, too late for the 17:00 window` };
  if (now >= START) return { action: 'run', why: `fired at ${hhmm} IST` };
  if (START - now > MAX_WAIT) return { action: 'skip', why: `fired at ${hhmm} IST, more than ${MAX_WAIT} min before 12:05` };
  return { action: 'wait', seconds: (START - now) * 60, why: `fired at ${hhmm} IST, waiting until 12:05` };
}
if (process.argv[1] && process.argv[1].endsWith('schedule-gate.mjs')) {
  const d = decide(process.argv[2], process.argv[3] === '1');
  console.log(`action=${d.action}\nseconds=${d.seconds || 0}\nwhy="${d.why}"`);
}
