/**
 * P0 regression test — grenade warning (1.5) and the heal() dead-latch (1.3b).
 *
 * 1.5  AiSystem.throwGrenade spawned a live 120-damage / 6.5m grenade and emitted
 *      nothing. ui.spawnGrenade (danger marker + grenade_warn beeps) was fully
 *      built with zero gameplay callers, so the only cue was a 5cm sphere.
 *
 * 1.3b heal() restored HP without clearing `dead`, minting a 100-HP corpse:
 *      damage() returns 0 while dead, regen is gated on !dead, hitbox off, ADS
 *      off, low-health grade latched — at full health.
 */
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] ?? 5373);
const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1024, height: 576 } });
p.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 300)));

await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 300000 });

const R = [];
const ck = (n, ok, d) => {
  R.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${d}`);
};

/* ---------------------------------------------- 1.3b heal clears dead ----- */
console.log('--- 1.3b: heal() must clear the dead flag ---');
const heal = await p.evaluate(async () => {
  const e = window.__ENGINE__;
  const pl = e.ctx.peek('player');
  const h = pl.health;
  h.reset(true);
  pl.applyDamage(500, null, { type: 'bullet' });
  const dead = { v: h.value, dead: h.dead };
  h.heal(100);
  const healed = { v: h.value, dead: h.dead };
  // A healed player must be damageable again — the real consequence of the latch.
  const dealt = pl.applyDamage(30, null, { type: 'bullet' });
  const after = { v: h.value, dealt };
  h.reset(true);
  return { dead, healed, after };
});
ck('player reaches 0 and is flagged dead', heal.dead.v === 0 && heal.dead.dead === true, JSON.stringify(heal.dead));
ck(
  'heal() restores HP AND clears dead',
  heal.healed.v === 100 && heal.healed.dead === false,
  `${JSON.stringify(heal.healed)} (before: heal(100) left dead=true -> a 100-HP corpse)`
);
ck(
  'healed player is damageable again',
  heal.after.dealt > 0 && heal.after.v < 100,
  `dealt=${heal.after.dealt} health=${heal.after.v}`
);

/* ------------------------------------------- 1.5 grenade danger marker ---- */
console.log('\n--- 1.5: throwGrenade must raise the danger marker ---');
const nade = await p.evaluate(async () => {
  const e = window.__ENGINE__;
  const ai = e.ctx.peek('ai');
  const ui = e.ctx.peek('ui');
  const pool = ui?.markers?.nadePool;
  const liveBefore = pool ? pool.items.filter((i) => i.alive).length : -1;
  const agent = (ai?.agents ?? []).find((a) => a.alive);
  if (!agent) return { error: 'no live agent' };
  const from = agent.position.clone();
  const target = e.ctx.camera.position.clone();
  ai.throwGrenade(agent, from, target);
  const liveAfter = pool ? pool.items.filter((i) => i.alive).length : -1;
  return { liveBefore, liveAfter, hadPool: !!pool };
});
if (nade.error) {
  ck('grenade warning raised', false, nade.error);
} else {
  ck('marker pool exists', nade.hadPool === true, `hadPool=${nade.hadPool}`);
  ck(
    'throwGrenade raises a danger marker',
    nade.liveAfter === nade.liveBefore + 1,
    `live markers ${nade.liveBefore} -> ${nade.liveAfter} (before: throwGrenade emitted nothing)`
  );
}

const f = R.filter((r) => !r.ok);
console.log(`\n===== ${R.length - f.length}/${R.length} PASSED =====`);
if (f.length) console.log('FAILED: ' + f.map((x) => x.n).join(' | '));
await b.close();
process.exit(f.length ? 1 : 0);
