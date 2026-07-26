/**
 * RC-3 regression test — nav connectivity.
 *
 * Unfixed measurements on this level: ~800 separate walkable components, 23% of
 * walkable cells stranded on islands, 3811/3872 cover picks cross-component,
 * 2718/2719 path failures cross-component, 2 of 6 agents spawned inside 10-21
 * cell islands. Agents stood in the open, jogged in place, and re-picked the
 * same unreachable cover every frame while the A* ration drained on solves that
 * could not succeed.
 *
 * Asserts: components are labelled; the labelling AGREES with A* (the critical
 * soundness property — a component map that disagrees with the pathfinder is
 * worse than none); cover picks and spawns are on the asker's island.
 */
import { chromium } from 'playwright';

const PORT = Number(process.argv[2] ?? 5373);
const b = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio'],
});
const p = await b.newPage({ viewport: { width: 1024, height: 576 } });
p.on('pageerror', (e) => console.log('[PAGEERROR]', String(e).slice(0, 400)));

await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__READY__===true', null, { timeout: 300000 });

const R = [];
const ck = (n, ok, d) => {
  R.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${d}`);
};

const info = await p.evaluate(() => {
  const ai = window.__ENGINE__.ctx.peek('ai');
  const g = ai.grid;
  const sizes = g.compSize ?? [];
  const total = sizes.reduce((a, c) => a + c, 0);
  const largest = sizes.length ? Math.max(...sizes) : 0;
  return {
    labelled: !!g.comp,
    components: g.componentCount ?? 0,
    walkable: g.walkableCount ?? 0,
    largest,
    strandedPct: total ? +(100 * (1 - largest / total)).toFixed(1) : -1,
    agents: ai.agents.length,
  };
});
console.log('nav:', JSON.stringify(info));
ck('components are labelled', info.labelled === true, `comp array present, ${info.components} components`);
ck('a dominant component exists', info.largest > 0, `largest=${info.largest} of ${info.walkable} walkable`);

/* --- SOUNDNESS: the component map must agree with A* ----------------------- */
// Sample random walkable cell pairs. For same-component pairs A* should mostly
// succeed; for cross-component pairs it must NEVER succeed. A single
// cross-component success would prove the labelling is stricter than the
// pathfinder, i.e. it is rejecting routes A* could actually find.
const sound = await p.evaluate(() => {
  const ai = window.__ENGINE__.ctx.peek('ai');
  const g = ai.grid;
  const THREE = window.__ENGINE__.ctx.scene.constructor;
  const cells = [];
  for (let i = 0; i < g.flags.length; i++) if (g.comp[i] >= 0) cells.push(i);
  const rnd = (n) => Math.floor((Math.sin(n * 12.9898) * 43758.5453 % 1 + 1) % 1 * cells.length);
  const out = [];
  const pos = (idx) => ({
    x: g.worldX(idx % g.nx),
    y: g.floor[idx],
    z: g.worldZ((idx / g.nx) | 0),
  });
  let crossTried = 0, crossSucceeded = 0, sameTried = 0, sameSucceeded = 0;
  const scratch = Array.from({ length: 64 }, () => ({ x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; }, copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } }));
  for (let k = 0; k < 400; k++) {
    const a = cells[rnd(k * 2 + 1)], bb = cells[rnd(k * 2 + 2)];
    if (a === undefined || bb === undefined || a === bb) continue;
    const same = g.comp[a] === g.comp[bb];
    // Bypass the new early-out so we measure raw A*, not the guard.
    const saved = g.comp;
    g.comp = null;
    const n = g.findPath(pos(a), pos(bb), scratch, { maxNodes: 20000 });
    g.comp = saved;
    if (same) { sameTried++; if (n > 0) sameSucceeded++; }
    else { crossTried++; if (n > 0) crossSucceeded++; }
  }
  return { crossTried, crossSucceeded, sameTried, sameSucceeded, rejected: g.rejectedUnreachable };
});
console.log('soundness:', JSON.stringify(sound));
ck(
  'SOUND: A* never crosses a component boundary',
  sound.crossSucceeded === 0,
  `${sound.crossSucceeded}/${sound.crossTried} cross-component pairs solved — must be 0, else the labelling rejects real routes`
);
ck(
  'component map is not over-strict (same-component pairs do solve)',
  sound.sameTried === 0 || sound.sameSucceeded > 0,
  `${sound.sameSucceeded}/${sound.sameTried} same-component pairs solved`
);

/* --- cover picks are on the asker island ---------------------------------- */
const cover = await p.evaluate(() => {
  const ai = window.__ENGINE__.ctx.peek('ai');
  const g = ai.grid, cm = ai.cover;
  const player = window.__ENGINE__.ctx.camera.position;
  let checked = 0, offIsland = 0;
  for (const a of ai.agents) {
    for (let k = 0; k < 12; k++) {
      const pick = cm.pick(a.position, player, { id: -1 });
      if (!pick) continue;
      checked++;
      const at = g.nearest(a.position.x, a.position.z, a.position.y);
      const pAt = g.nearest(pick.x, pick.z, pick.y);
      if (at >= 0 && pAt >= 0 && g.comp[at] !== g.comp[pAt]) offIsland++;
    }
  }
  return { checked, offIsland, coverRejected: cm.rejectedUnreachable ?? 0 };
});
console.log('cover:', JSON.stringify(cover));
ck(
  'cover picks are always reachable',
  cover.checked === 0 || cover.offIsland === 0,
  `${cover.offIsland}/${cover.checked} picks off-island (unfixed: 3811/3872); ${cover.coverRejected} candidates rejected as unreachable`
);

/* --- spawns share the player island --------------------------------------- */
const spawn = await p.evaluate(() => {
  const ai = window.__ENGINE__.ctx.peek('ai');
  const g = ai.grid;
  const player = window.__ENGINE__.ctx.camera.position;
  const at = g.nearest(player.x, player.z, player.y);
  const pc = at >= 0 ? g.comp[at] : -1;
  let stranded = 0;
  for (const a of ai.agents) {
    const c = g.nearest(a.position.x, a.position.z, a.position.y);
    if (c >= 0 && g.comp[c] !== pc) stranded++;
  }
  return { pc, stranded, agents: ai.agents.length, rejectedSpawns: ai.stats.spawnsRejectedUnreachable ?? 0 };
});
console.log('spawn:', JSON.stringify(spawn));
ck(
  'no agent is stranded off the player island',
  spawn.stranded === 0,
  `${spawn.stranded}/${spawn.agents} stranded (unfixed: 2/6); ${spawn.rejectedSpawns} spawn points rejected as unreachable`
);

const f = R.filter((r) => !r.ok);
console.log(`\n===== ${R.length - f.length}/${R.length} PASSED =====`);
if (f.length) console.log('FAILED: ' + f.map((x) => x.n).join(' | '));
await b.close();
process.exit(f.length ? 1 : 0);
