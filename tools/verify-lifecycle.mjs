/**
 * 2.4 regression test — corpse retirement and reinforcement waves.
 *
 * Before: `deadTime` accumulated and fed nothing but a debug log. There was no
 * `agents.splice` anywhere in the codebase and `populate()` only ever ran at
 * boot. Bodies accumulated forever while the roster only ever shrank, so the
 * level emptied permanently — a match you could not lose and, after the last
 * kill, could not fight.
 *
 * Runs in LOCKSTEP so the 14s corpse linger and 6s reinforce delay are exact
 * frame counts rather than a wall-clock race on a ~21fps build.
 */
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] ?? 5373);
const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1024, height: 576 } });
p.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 300)));

// capture=1 suppresses the garrison, so force it on; lockstep gives exact time.
await p.goto(`http://127.0.0.1:${PORT}/?capture=1&lockstep=1`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 300000 });

const step = (n) => p.evaluate((k) => window.__PUMP__(k), n);
const snap = () =>
  p.evaluate(() => {
    const ai = window.__ENGINE__.ctx.peek('ai');
    return {
      agents: ai.agents.length,
      alive: ai.agents.filter((a) => a.alive).length,
      corpses: ai.agents.filter((a) => !a.alive).length,
      retired: ai.stats.retired ?? 0,
      waves: ai.stats.waves ?? 0,
      squadMembers: ai.squads.reduce((n, s) => n + s.members.length, 0),
    };
  });

const R = [];
const ck = (n, ok, d) => {
  R.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${d}`);
};

// Spawn a garrison by hand (capture mode skipped it).
await p.evaluate(() => {
  const ai = window.__ENGINE__.ctx.peek('ai');
  ai.forcePopulate = true;
  ai.reinforce = true;
  if (!ai.agents.length) ai.populate({ squads: 2, perSquad: 3 });
});
await step(6);
const t0 = await snap();
console.log('t0  ', JSON.stringify(t0));
ck('garrison present', t0.alive > 0, `${t0.alive} alive`);

// Kill everyone.
await p.evaluate(() => {
  const ai = window.__ENGINE__.ctx.peek('ai');
  for (const a of ai.agents) if (a.alive) a.applyDamage(999, 'torso', a.position, { x: 0, y: 0, z: 1 });
});
await step(6);
const t1 = await snap();
console.log('t1  ', JSON.stringify(t1), '(all killed)');
ck('all agents dead', t1.alive === 0, `alive=${t1.alive} corpses=${t1.corpses}`);
ck('corpses still present immediately after death', t1.corpses > 0, `corpses=${t1.corpses}`);

// 14s corpse linger + margin = 16s = 960 fixed frames.
await step(960);
const t2 = await snap();
console.log('t2  ', JSON.stringify(t2), '(+16s)');
ck(
  'corpses are RETIRED after the linger window',
  t2.retired >= t1.corpses,
  `retired=${t2.retired} of ${t1.corpses} corpses (before: no splice existed anywhere)`
);
ck(
  'squad rosters do not leak disposed members',
  t2.squadMembers <= t2.agents,
  `squadMembers=${t2.squadMembers} agents=${t2.agents}`
);

// Reinforcement should have fired at the 6s mark, well inside that window.
ck(
  'a reinforcement WAVE arrives after the garrison is cleared',
  t2.waves > 0 && t2.alive > 0,
  `waves=${t2.waves} alive=${t2.alive} (before: populate() ran only at boot, level emptied forever)`
);

const f = R.filter((r) => !r.ok);
console.log(`\n===== ${R.length - f.length}/${R.length} PASSED =====`);
if (f.length) console.log('FAILED: ' + f.map((x) => x.n).join(' | '));
await b.close();
process.exit(f.length ? 1 : 0);
