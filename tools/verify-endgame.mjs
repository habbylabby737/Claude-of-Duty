/**
 * Delta-queue regression test — N1, N2, N6, N4.
 *
 * N1 and N2 were MY bugs, introduced with MatchSystem two hours earlier and
 * caught by the post-RC-3 red team:
 *   N1  update() opened with `if (this.over) return;` ABOVE the respawn
 *       countdown, so _end('time') was the last frame that ever serviced it.
 *       Dying as the clock ran out froze the player permanently: 0 HP, control
 *       off, respawnIn stuck mid-count, only exit a page reload.
 *   N2  _onPlayerDeath() returned bare on `over`, leaving a 0-HP invulnerable
 *       but controllable corpse with no recovery path.
 *   N6  the weapon live gate never checked death, so a corpse kept full trigger
 *       authority and respawned with the magazine it had emptied while dead.
 *   N4  the grenade danger marker copied position by value and pinned itself at
 *       the throw point.
 */
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] ?? 5373);
const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1024, height: 576 } });
p.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 300)));

await p.goto(`http://127.0.0.1:${PORT}/?capture=1&lockstep=1`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 300000 });

const step = (n) => p.evaluate((k) => window.__PUMP__(k), n);
const R = [];
const ck = (n, ok, d) => {
  R.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${d}`);
};

/* ---- N1: clock hits 0 while dead must NOT hard-lock -------------------- */
console.log('--- N1: die, then let the clock expire mid-respawn ---');
const n1 = await p.evaluate(async () => {
  const e = window.__ENGINE__;
  const m = e.ctx.peek('match');
  const pl = e.ctx.peek('player');
  m.over = false;
  m.awaitingRespawn = false;
  pl.health.reset(true);
  pl.setControlEnabled(true);
  m.timeLeft = 600;
  pl.applyDamage(500, null, { type: 'bullet' });      // start the respawn cycle
  return { awaiting: m.awaitingRespawn, respawnIn: m.respawnIn };
});
await step(2);
// Expire the clock while the respawn is still counting down.
await p.evaluate(() => { window.__ENGINE__.ctx.peek('match').timeLeft = 0.001; });
await step(4);
const afterEnd = await p.evaluate(() => {
  const e = window.__ENGINE__, m = e.ctx.peek('match'), pl = e.ctx.peek('player');
  return { over: m.over, awaiting: m.awaitingRespawn, respawnIn: +m.respawnIn.toFixed(3), hp: pl.health.value, dead: pl.health.dead, ctrl: pl.controlEnabled };
});
console.log('   at match end:', JSON.stringify(afterEnd));
await step(400); // 6.6s — well past the 3s respawn delay
const n1end = await p.evaluate(() => {
  const e = window.__ENGINE__, m = e.ctx.peek('match'), pl = e.ctx.peek('player');
  return { over: m.over, awaiting: m.awaitingRespawn, respawnIn: +m.respawnIn.toFixed(3), hp: pl.health.value, dead: pl.health.dead, ctrl: pl.controlEnabled };
});
console.log('   +6.6s      :', JSON.stringify(n1end));
ck('N1 player is NOT frozen after the clock expires mid-respawn',
  n1end.hp > 0 && n1end.dead === false && n1end.ctrl === true,
  `hp=${n1end.hp} dead=${n1end.dead} ctrl=${n1end.ctrl} (before: hp 0, ctrl false, respawnIn frozen forever)`);

/* ---- N2: dying AFTER match end must not leave a corpse ------------------ */
console.log('\n--- N2: die after the match has already ended ---');
await p.evaluate(() => {
  const e = window.__ENGINE__, pl = e.ctx.peek('player');
  e.ctx.peek('match').over = true;          // round already finished
  pl.applyDamage(500, null, { type: 'bullet' });
});
await step(6);
const n2 = await p.evaluate(() => {
  const pl = window.__ENGINE__.ctx.peek('player');
  return { hp: pl.health.value, dead: pl.health.dead, ctrl: pl.controlEnabled };
});
console.log('   ', JSON.stringify(n2));
ck('N2 no permanent corpse after match end',
  n2.dead === false && n2.hp > 0,
  `hp=${n2.hp} dead=${n2.dead} (before: hp 0, dead true, controllable, terminal)`);

/* ---- N6: a dead player cannot fire ------------------------------------- */
console.log('\n--- N6: dead players must not shoot ---');
const n6 = await p.evaluate(async () => {
  const e = window.__ENGINE__, pl = e.ctx.peek('player'), w = e.ctx.peek('weapons');
  const m = e.ctx.peek('match');
  m.over = false; m.awaitingRespawn = false;
  pl.health.reset(true);
  const before = w.stats.fired;
  pl.applyDamage(500, null, { type: 'bullet' });   // now dead
  const wasDead = pl.health.dead;
  // Ask the weapon to fire directly, bypassing input plumbing.
  let blocked = true;
  for (let i = 0; i < 10; i++) {
    if (typeof w.tryFire === 'function') { try { w.tryFire(); } catch { /* ignore */ } }
  }
  const after = w.stats.fired;
  if (after > before) blocked = false;
  return { wasDead, before, after, blocked, liveGateSeesDead: pl.health.dead };
});
console.log('   ', JSON.stringify(n6));
ck('N6 dead player fires nothing', n6.wasDead === true && n6.after === n6.before,
  `fired ${n6.before} -> ${n6.after} while dead (before: 30 -> 0 rounds emptied as a corpse)`);

/* ---- N4: grenade marker follows the body ------------------------------- */
console.log('\n--- N4: danger marker must track the grenade ---');
const n4 = await p.evaluate(async () => {
  const e = window.__ENGINE__;
  const ai = e.ctx.peek('ai'), ui = e.ctx.peek('ui');
  ai.forcePopulate = true;
  if (!ai.agents.length) ai.populate({ squads: 1, perSquad: 3 });
  const agent = ai.agents.find((a) => a.alive);
  if (!agent) return { error: 'no agent' };
  const from = agent.position.clone();
  const target = e.ctx.camera.position.clone();
  ai.throwGrenade(agent, from, target);
  const it = ui.markers.nadePool.items.find((x) => x.alive);
  return {
    hasFollow: !!it?.follow,
    start: it ? { x: +it.node._pos.x.toFixed(2), z: +it.node._pos.z.toFixed(2) } : null,
  };
});
if (n4.error) ck('N4 marker tracks the grenade', false, n4.error);
else {
  await step(45); // 0.75s of flight
  const moved = await p.evaluate(() => {
    const ui = window.__ENGINE__.ctx.peek('ui');
    const it = ui.markers.nadePool.items.find((x) => x.alive);
    return it ? { x: +it.node._pos.x.toFixed(2), z: +it.node._pos.z.toFixed(2) } : null;
  });
  const d = moved ? Math.hypot(moved.x - n4.start.x, moved.z - n4.start.z) : 0;
  console.log('   follow=', n4.hasFollow, 'start=', JSON.stringify(n4.start), 'after=', JSON.stringify(moved));
  ck('N4 marker FOLLOWS the grenade in flight', n4.hasFollow === true && d > 0.25,
    `moved ${d.toFixed(2)}m in 0.75s (before: 11/11 throws never moved)`);
}

const f = R.filter((r) => !r.ok);
console.log(`\n===== ${R.length - f.length}/${R.length} PASSED =====`);
if (f.length) console.log('FAILED: ' + f.map((x) => x.n).join(' | '));
await b.close();
process.exit(f.length ? 1 : 0);
