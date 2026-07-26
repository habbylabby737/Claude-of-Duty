/**
 * Match/death/respawn regression test.
 *
 * Asserts the four Batch-1 fixes against the RUNNING build, in lockstep so the
 * result does not depend on wall-clock or frame rate:
 *   1. player:death now has a subscriber -> death is observable
 *   2. respawn() is actually called -> health returns to max, `dead` clears
 *   3. the match clock ticks
 *   4. scoreThem increments on player death
 *   5. ai.getHudActors() exists -> the minimap can collect blips
 */
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] ?? 5373);
const URL = `http://127.0.0.1:${PORT}/?capture=1&lockstep=1`;

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('console', (m) => {
  const t = m.text();
  if (/error|fail|cannot|undefined is not/i.test(t)) console.log('  [page]', t.slice(0, 160));
});
p.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
// Boot is SLOW: ~60s warm, longer cold. Shader prewarm alone measured 46.8s
// (34 -> 170 programs). This is not a hang; give it real headroom.
await p.waitForFunction('window.__READY__===true', null, { timeout: 300000 });

const step = (n) => p.evaluate((k) => window.__PUMP__(k), n);
const read = () =>
  p.evaluate(() => {
    const e = window.__ENGINE__;
    const player = e.ctx.peek('player');
    const ui = e.ctx.peek('ui');
    const match = e.ctx.peek('match');
    const ai = e.ctx.peek('ai');
    return {
      health: player?.health?.value ?? null,
      dead: player?.health?.dead ?? null,
      controlEnabled: player?.controlEnabled ?? null,
      timeLeft: ui?.state?.timeLeft ?? null,
      scoreUs: ui?.state?.scoreUs ?? null,
      scoreThem: ui?.state?.scoreThem ?? null,
      awaitingRespawn: match?.awaitingRespawn ?? null,
      matchRegistered: !!match,
      hudActorsType: typeof ai?.getHudActors,
      hudActorCount: typeof ai?.getHudActors === 'function' ? ai.getHudActors().length : -1,
      blipCount: ui?._blipCount ?? null,
    };
  });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};

console.log('\n--- baseline ---');
const t0 = await read();
console.log(JSON.stringify(t0));
check('match subsystem registered', t0.matchRegistered === true, `match=${t0.matchRegistered}`);
check('ai.getHudActors() exists', t0.hudActorsType === 'function', `typeof=${t0.hudActorsType} count=${t0.hudActorCount}`);

// ---- clock ticks -----------------------------------------------------------
await step(120); // 2 seconds of fixed 1/60 steps
const t1 = await read();
check('match clock ticks', t1.timeLeft !== null && t1.timeLeft < t0.timeLeft,
  `${t0.timeLeft?.toFixed(2)} -> ${t1.timeLeft?.toFixed(2)}`);

// ---- minimap blips ---------------------------------------------------------
check('minimap collects blips', (t1.blipCount ?? 0) > 0, `blipCount=${t1.blipCount} of ${t1.hudActorCount} agents`);

// ---- kill the player -------------------------------------------------------
console.log('\n--- applying lethal damage ---');
await p.evaluate(() => {
  const pl = window.__ENGINE__.ctx.peek('player');
  pl.applyDamage(500, null, { type: 'bullet' });
});
await step(2);
const t2 = await read();
check('player reaches 0 and is flagged dead', t2.health === 0 && t2.dead === true,
  `health=${t2.health} dead=${t2.dead}`);
check('enemy score incremented on death', t2.scoreThem === t0.scoreThem + 1,
  `${t0.scoreThem} -> ${t2.scoreThem}`);
check('control removed while dead', t2.controlEnabled === false, `controlEnabled=${t2.controlEnabled}`);
check('respawn is pending', t2.awaitingRespawn === true, `awaitingRespawn=${t2.awaitingRespawn}`);

// ---- wait out the respawn delay (3s = 180 fixed steps, +margin) ------------
console.log('\n--- waiting out respawn delay ---');
await step(260);
const t3 = await read();
check('player RESPAWNED (health restored)', t3.health === 100 && t3.dead === false,
  `health=${t3.health} dead=${t3.dead}`);
check('control restored after respawn', t3.controlEnabled === true, `controlEnabled=${t3.controlEnabled}`);
check('respawn no longer pending', t3.awaitingRespawn === false, `awaitingRespawn=${t3.awaitingRespawn}`);

// ---- damage again post-respawn: proves not stuck invulnerable --------------
console.log('\n--- damage again after respawn (invulnerability check) ---');
await p.evaluate(() => window.__ENGINE__.ctx.peek('player').applyDamage(25, null, { type: 'bullet' }));
await step(2);
const t4 = await read();
check('player takes damage again after respawn', t4.health < 100 && t4.health > 0,
  `health=${t4.health} (was permanently invulnerable in the original)`);

await p.screenshot({ path: process.argv[3] ?? '/tmp/batch1.png' });

const failed = results.filter((r) => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} PASSED =====`);
if (failed.length) console.log('FAILED: ' + failed.map((f) => f.name).join(' | '));
await b.close();
process.exit(failed.length ? 1 : 0);
