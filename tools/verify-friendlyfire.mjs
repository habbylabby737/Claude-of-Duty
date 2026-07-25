/**
 * RC-1 regression test — shooter identity on `damage:dealt`.
 *
 * Before the fix, `physics.fireBullet` emitted anonymous damage, so:
 *   - `ai` applied every round to any Agent it hit with no team check
 *   - `ui` credited the player with any kill whose target was not the player
 * Measured on the unfixed build: 25/25 agent damage events same-team, 5 of 6
 * enemies dead by t=20s with the player idle, and scoreUs:5 with zero shots fired.
 *
 * This asserts the inverse: with the player IDLE, the garrison survives and the
 * scoreboard stays clean; and when the PLAYER deals damage, credit still lands.
 *
 * NOTE: AI RNG is seeded from Math.random() in normal play, so exact per-session
 * numbers vary. Assertions are directional (survival, zero phantom credit), not
 * exact counts.
 */
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] ?? 5373);
const IDLE_SECONDS = Number(process.argv[3] ?? 30);

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1024, height: 576 } });
p.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 300)));

// Normal play (no ?capture=1) so the garrison actually spawns.
await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 300000 });

// Count same-team damage applications and player credit as they happen.
await p.evaluate(() => {
  const e = window.__ENGINE__;
  window.__RC1__ = { sameTeam: 0, crossTeam: 0, anonymous: 0, total: 0 };
  e.ctx.events.on('damage:dealt', (ev) => {
    const s = window.__RC1__;
    s.total++;
    if (!ev.source) s.anonymous++;
    else if (ev.source?.team !== undefined && ev.target?.team !== undefined) {
      if (ev.source.team === ev.target.team) s.sameTeam++;
      else s.crossTeam++;
    }
  });
});

const snap = () =>
  p.evaluate(() => {
    const e = window.__ENGINE__;
    const ai = e.ctx.peek('ai');
    const ui = e.ctx.peek('ui');
    const w = e.ctx.peek('weapons');
    return {
      agents: ai?.agents?.length ?? 0,
      alive: (ai?.agents ?? []).filter((a) => a.alive).length,
      // Total garrison HP. The real question is not whether same-team rounds are
      // FIRED (they are — agents cross each other's line of fire constantly) but
      // whether any of that damage is APPLIED.
      totalHp: (ai?.agents ?? []).reduce((n, a) => n + Math.max(0, a.health ?? 0), 0),
      friendlyBlocked: ai?.stats?.friendlyBlocked ?? 0,
      scoreUs: ui?.state?.scoreUs ?? null,
      shotsFired: w?.stats?.fired ?? null,
      rc1: window.__RC1__,
    };
  });

const R = [];
const ck = (n, ok, d) => {
  R.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${d}`);
};

const t0 = await snap();
console.log('t=0  ', JSON.stringify(t0));

console.log(`\n--- player IDLE for ${IDLE_SECONDS}s (this is where the garrison used to wipe itself) ---`);
await new Promise((r) => setTimeout(r, IDLE_SECONDS * 1000));
const t1 = await snap();
console.log(`t=${IDLE_SECONDS}s`, JSON.stringify(t1));

ck('player fired nothing (control held)', t1.shotsFired === 0, `shotsFired=${t1.shotsFired}`);
ck(
  'garrison SURVIVES an idle match',
  t1.alive === t0.agents,
  `${t1.alive}/${t0.agents} alive after ${IDLE_SECONDS}s (unfixed build: 1/6 by t=20s)`
);
// Same-team rounds are still FIRED — agents cross each other's line of fire. What
// must be true is that none of that damage is APPLIED: the garrison loses no HP.
ck(
  'no same-team damage APPLIED (garrison at full HP)',
  t1.totalHp === t0.totalHp,
  `totalHp ${t0.totalHp} -> ${t1.totalHp}; ${t1.friendlyBlocked} friendly rounds blocked out of ${t1.rc1?.sameTeam} same-team hits`
);
ck(
  'the guard actually fired (test is not vacuous)',
  (t1.friendlyBlocked ?? 0) > 0,
  `friendlyBlocked=${t1.friendlyBlocked} — if 0, no friendly fire occurred and this run proves nothing`
);
ck(
  'no anonymous damage events',
  (t1.rc1?.anonymous ?? 0) === 0,
  `anonymous=${t1.rc1?.anonymous} of ${t1.rc1?.total}`
);
ck(
  'NO phantom score while idle',
  t1.scoreUs === 0,
  `scoreUs=${t1.scoreUs} with ${t1.shotsFired} shots fired (unfixed build: 5 with 0 shots)`
);

// ---- positive control: player damage MUST still be credited ----------------
console.log('\n--- positive control: player kills an agent directly ---');
const before = t1.scoreUs;
await p.evaluate(() => {
  const e = window.__ENGINE__;
  const ai = e.ctx.peek('ai');
  const victim = (ai?.agents ?? []).find((a) => a.alive);
  if (!victim) return;
  // Emit exactly what physics emits for a player round, including identity.
  e.ctx.events.emit('damage:dealt', {
    target: victim,
    amount: 500,
    headshot: false,
    killed: false,
    point: victim.position,
    source: 'player',
  });
});
await new Promise((r) => setTimeout(r, 800));
const t2 = await snap();
ck(
  'player-sourced kill STILL credits the player',
  t2.scoreUs === before + 1,
  `scoreUs ${before} -> ${t2.scoreUs}`
);
ck('that kill actually killed an agent', t2.alive === t1.alive - 1, `alive ${t1.alive} -> ${t2.alive}`);

const f = R.filter((r) => !r.ok);
console.log(`\n===== ${R.length - f.length}/${R.length} PASSED =====`);
if (f.length) console.log('FAILED: ' + f.map((x) => x.n).join(' | '));
await b.close();
process.exit(f.length ? 1 : 0);
