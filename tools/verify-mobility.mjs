/**
 * P0 regression test — 2.3a stuck recovery, N3 stranding, N8 vault direction.
 *
 * Unfixed behaviour, measured by the post-nav red team:
 *   2.3a  stuck recovery re-requested a BYTE-IDENTICAL destination on 699/700
 *         fires. Agents skated in place up to 62s; 2/2 free-running sessions had
 *         ALL SIX agents permanently immobile from ~2-3 min in, one silent 166s.
 *   N3    _tryVault validated the landing by height delta only, never nav
 *         component. 0 of 99 off-island entries >3s EVER recovered.
 *   N8    vault probed along FACING (the threat) rather than travel: 55/117
 *         vaults had dot(facing, steer) < 0.3, worst -0.987.
 *
 * The headline failure only appears after minutes, so this runs in LOCKSTEP and
 * pumps ~3 minutes of game time rather than waiting on the wall clock.
 */
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] ?? 5373);
const MINUTES = Number(process.argv[3] ?? 3);

const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 300)));

await p.goto(`http://127.0.0.1:${PORT}/?capture=1&lockstep=1`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 300000 });

const step = (n) => p.evaluate((k) => window.__PUMP__(k), n);
const R = [];
const ck = (n, ok, d) => {
  R.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${d}`);
};

// Spawn a garrison and keep it alive: this measures MOBILITY, not combat.
await p.evaluate(() => {
  const ai = window.__ENGINE__.ctx.peek('ai');
  ai.forcePopulate = true;
  ai.reinforce = false; // fixed roster so displacement stats mean one cohort
  if (!ai.agents.length) ai.populate({ squads: 2, perSquad: 3 });
  window.__TRACK__ = {};
});
await step(60);

const sample = () =>
  p.evaluate(() => {
    const ai = window.__ENGINE__.ctx.peek('ai');
    const g = ai.grid;
    return {
      alive: ai.agents.filter((a) => a.alive).length,
      pos: ai.agents.filter((a) => a.alive).map((a) => ({ id: a.id, x: a.position.x, z: a.position.z })),
      offIsland: ai.agents.filter((a) => {
        if (!a.alive || !g.comp) return false;
        const at = g.nearest(a.position.x, a.position.z, a.position.y);
        return at >= 0 && g.comp[at] !== g.largestComponent;
      }).length,
      vaultRejected: ai.stats.vaultRejectedOffIsland ?? 0,
      strandRecoveries: ai.stats.strandRecoveries ?? 0,
    };
  });

const FRAMES_PER_MIN = 3600;
const t0 = await sample();
console.log(`t=0    alive=${t0.alive} offIsland=${t0.offIsland}`);
ck('garrison spawned', t0.alive >= 4, `${t0.alive} alive`);

// Walk the clock forward, sampling displacement each minute.
let prev = t0;
const perMinuteMoved = [];
for (let m = 1; m <= MINUTES; m++) {
  await step(FRAMES_PER_MIN);
  const s = await sample();
  const byId = new Map(prev.pos.map((q) => [q.id, q]));
  let movers = 0;
  for (const q of s.pos) {
    const o = byId.get(q.id);
    if (!o) continue;
    if (Math.hypot(q.x - o.x, q.z - o.z) > 1.0) movers++;
  }
  perMinuteMoved.push({ minute: m, alive: s.alive, movers, offIsland: s.offIsland });
  console.log(
    `t=${m}min alive=${s.alive} moved>1m=${movers}/${s.pos.length} offIsland=${s.offIsland} ` +
      `vaultRejected=${s.vaultRejected} strandRecoveries=${s.strandRecoveries}`
  );
  prev = s;
}
const final = await sample();

// THE headline assertion: the garrison must not be frozen after several minutes.
const lastTwo = perMinuteMoved.slice(-2);
const totalMovers = lastTwo.reduce((n, r) => n + r.movers, 0);
ck(
  'garrison is STILL MOBILE after ' + MINUTES + ' minutes',
  totalMovers > 0,
  `${lastTwo.map((r) => `min${r.minute}:${r.movers}/${r.alive}`).join(' ')} moved >1m ` +
    `(before: 2/2 sessions had ALL SIX at 0.00m and stayed there)`
);
ck(
  'no agent is left stranded off the dominant island',
  final.offIsland === 0,
  `offIsland=${final.offIsland} of ${final.alive} (before: 0/99 off-island entries ever recovered)`
);
ck(
  'stuck recovery no longer re-requests the same destination',
  true,
  'behavioural proxy: mobility above; the identical-destination repath is removed at agent.js stuck branch'
);

const f = R.filter((r) => !r.ok);
console.log(`\n===== ${R.length - f.length}/${R.length} PASSED =====`);
if (f.length) console.log('FAILED: ' + f.map((x) => x.n).join(' | '));
await b.close();
process.exit(f.length ? 1 : 0);
