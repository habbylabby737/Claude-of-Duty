# DELTA FIX QUEUE — post RC-1/RC-3 verification pass (4 probes, adversarially verified)

## 1. NEW ROWS (ranked by player-visible impact per line of change)

**N1 — Clock hitting 0 during death cam hard-locks the game forever** · game-breaking · `src/match/index.js:100`
Root cause: `update()` opens `if (this.over) return;` and the respawn countdown (102-105) lives below it; `_end('time')` at 115 is the last frame that ever services `respawnIn`. Reproduced: `respIn` frozen at 1.483 for 58s of game time, `ctrl:false`, W held → zero movement. No restart in the pause menu; only exit is page reload.
Fix: service the respawn countdown before the `over` early-out, or in `_end()` call `_respawn()` immediately when `awaitingRespawn`. ~2 lines.

**N2 — Dying after match end = permanent 0-HP invulnerable controllable corpse** · game-breaking · `src/match/index.js:60`
Root cause: `_onPlayerDeath()` returns on `this.over`, and nothing outside src/match reads match state (grep: zero `peek('match')` hits elsewhere) so AI keeps fighting after the banner; `health.damage()` returns 0 while dead, nothing calls `heal()`. Reproduced: `{hp:0, dead:true, ctrl:true}` stable indefinitely.
Fix: on `_end()`, freeze AI targeting + weapon firing and heal/respawn the player. Wire the existing `heal()` (which already clears the dead flag, health.js:142-144).

**N3 — Agents strand permanently on disconnected nav islands; nothing anywhere recovers them** · game-breaking · `src/ai/agent.js:719` (+ walk-caused seam crossings)
Root cause: `_tryVault` validates landing only by height delta, never `grid.comp`; controller can also walk seams the grid marks unwalkable (DV1: 23 vault-caused / 7 walk-caused). Once off-island, findPath (nav.js:332) and CoverMap.pick (nav.js:562) reject everything forever. 5/5 sessions had ≥1 agent frozen idle 55-86s of a 90s fight; 0/99 off-island entries >3s ever recovered.
Fix (both halves needed): (a) reject vault when landing `grid.comp` ≠ current comp (~3 lines); (b) recovery: if own comp ≠ path-goal comp for >2s, path to nearest cell of the largest component. (a) alone leaves walk-caused strandings.

**N4 — GRENADE marker frozen at the throw origin; a grenade at your feet is drawn 16m away and DANGER CLOSE never fires** · severe · `src/ui/markers.js:180`
Root cause: `spawnGrenade` copies position by value; `updateGrenades` re-projects the stale point (196) and measures the label threshold against it (198). Caller comment (ai/index.js:766) claims tracking; ai/index.js:769 already passes `body?.position`. 11/11 throws markerMoved=false, max drift 28.8m; GRENADE label on 14/14 including 6 detonations inside blast radius; pixel proof `scratchpad/rt2/marker-wrong-2.png` (grenade 0.30m from player, pips on the horizon at 16.5m).
Fix: store `it.body = body`, refresh `node._pos` from body position each frame, fall back to last known when body gone. markers.js only.

**N5 — One rifle round deals 2-5x listed damage through stacked hit capsules (up to 163 HP from a 33-damage round)** · severe · `src/physics/index.js:752`
Root cause: one `damage:dealt` per non-exit capsule impact, and both torso and head capsules of the SAME agent are charged in full (`damageScale` yields 130-132 entries). UI draws 2-6 hitmarkers/damage numbers per trigger pull. Reporter's numbers were long-range and UNDERSTATED it — at falloff 1.0, shots produced 62-163 HP applied.
Fix: accumulate per (round, actor) in `fireBullet` and emit one summed event with best hit part. NOT newly reachable — this was live all along.

**N6 — Player keeps firing while dead; spent ammo not restored on respawn** · severe · `src/weapons/index.js:600`
Root cause: `live` gate checks `input.frozen`/`enabled`/debug, never `player.dead`; `setControlEnabled(false)` touches movement only. Reproduced with real mouse input: 30→13→0 rounds fired as a corpse, respawned with the emptied mag; kills while dead fully credited (+100 XP, scoreUs++).
Fix: `&& player?.dead !== true` on the live gate; release trigger state in `setControlEnabled(false)`. 1-2 lines.

**N7 — Agent in transit to cover is weapon-down and silent without bound while the route stalls — up to 63s in the open, player in view** · severe · `src/ai/agent.js:515`
Root cause: `cover && !atCover` branch forces `wantFire=false, aimWeight=0.35`; only escape requires `!hasMoveTarget && !pathPending`, which a wedged-but-live path never satisfies. Measured runs of 16.8s, 22.0s, 63s stalled with `targetVisible && !wantFire`; 39-55% of all agent-frames sit in this branch.
Fix: progress timeout — if distance-to-`coverPos` hasn't shrunk for ~1.5s, drop cover + `release()` + `repathTimer=0`, falling through to the existing fire-from-here branch (mirror the guard already at 500-508).

**N8 — Vault probes along facing (the threat direction), not travel — backward hops every 2.5s, and it's the main feeder onto the islands in N3** · severe · `src/ai/agent.js:707`
Root cause: `fwd` from `this.yaw`, which lines 658-661 point at the threat whenever engaged. 55/117 vaults had dot(facing, steer) < 0.3 (worst -0.987); one 13-vault backward loop every ~3s (the vaultCooldown) for 27s. 14/117 vaults changed component, all onto islands ≤40 cells.
Fix: probe along normalised `this._steer` (yaw fallback when steer ~0), require within ~45° of the path segment.

**N9 — Garrison suppresses ITSELF: `bullet:impact` suppression has no source/team check** · noticeable · `src/ai/index.js:322-329`
Root cause: same class as RC-1 — the handler applies suppression to any agent within 3.2m with no source identity. Every suppressed frame measured in 11 cover-squad sessions occurred with the player never firing a shot. This is the enabler for N10's visible freezes.
Fix: thread `source` (already available post-RC-1 in physics.fireBullet) and skip same-team impacts, exactly like the RC-1 damage guard at index.js:332-345.

**N10 — SUPPRESSED pins an agent wherever it stands, up to 9.5m short of the cover it was running to** · noticeable · `src/ai/agent.js:442`
Root cause: gate tests `this.cover` assigned, never reached; SUPPRESSED case forces `desiredSpeed=0` with no repath until meter decays. Reproduced 4/5 sessions, 43-83% of suppressed frames >1.2m from cover. (Reporter's 9.5s duration refuted — max continuous 4.1s with player idle; real fire will extend it.)
Fix: add `&& this.position.distanceTo(this.coverPos) < 0.85` to the gate, or let SUPPRESSED keep closing at crouch speed.

**N11 — Each agent throws exactly one grenade per life; the reuse cooldown it rolls is dead code** · noticeable · `src/ai/agent.js:791`
Root cause: `hasGrenade = true` only in the constructor (217); `_throwGrenade` clears it and rolls a 16-34s timer nothing consumes (squad.js:122-125 ration likewise dead). LS-A: zero throws for the final 116.8s with all agents alive. Scope: per life/wave — reinforcement waves re-arm.
Fix: in `update()`, `hasGrenade = true` when `grenadeCooldown <= 0` (wire the timer that already exists). 1 line.

**N12 — Peek offset overwrites `coverPos`, so a settled agent fails its own at-cover test and abandons cover ~15x/min** · noticeable · `src/ai/agent.js:531`
Root cause: `coverPos.copy()` of the 0.62m lateral peek point; at-cover test (512) and release guard (500-508) measure against it. Causality: 46/46 peek-writes pushing coverPos >0.85m were followed by cover loss the NEXT frame (controls 0/23). Half re-claim instantly; half sprint 1.8-19.2m to different cover, weapon down 1-3s, releasing the point to squadmates. (This is the real defect behind existing row 3.14 — see below.)
Fix: store the peek target in its own field (`this.peekPos`); leave `coverPos` as the `_goTo` destination.

**N13 — Cover is picked with no line-of-fire test, contrary to both the build comment and pick's docstring** · noticeable · `src/ai/nav.js:508`
Root cause: comment at 508 promises peek rays; none cast. `pick()` (560-598) has zero `lineOfSight` calls. 16-49% of at-cover combat frames (seed-dependent, one layout) had no LOS from any of the three shooting positions; stable score means the repath re-picks the same blind point. Player experiences a firefight with fewer guns than enemies.
Fix: cast the two peek rays at build time, store `shootable` + working sides; or add the LOS term the docstring already advertises to `pick()`.

**N14 — Agents throw grenades with no line-of-fire test: 43% of throws hit the wall in front of them** · noticeable · `src/ai/agent.js:567`
Root cause: gate is distance+recency only under a comment promising "line of fire". 6/14 throws sight-blocked; 2 of those 6 detonated inside the thrower's own radius (guard held, 0 damage — hence not severe). Ballistic solve refuted as cause (dot=1.000 on all 6 scripted throws).
Fix: add `this.targetVisible &&` at 568, or probe `phys.lineOfSight(muzzle, aimPoint)` in `_throwGrenade`; on reject keep `hasGrenade` and roll a short cooldown.

**N15 — The player's own deaths never appear in the killfeed — the feed is permanently empty in AI-dominated rounds** · noticeable · `src/match/index.js:60` / `src/ui/index.js`
Root cause: only two killfeed.push sites, both player-credit or agent-death; `player:death` has one subscriber (match) which never pushes. 11 player deaths across 2 sessions, 0 rows. The `'OPERATOR'` default in the actor:death handler is written for this case and never reached.
Fix: push a row from the player-death path with the killing source; give Agent a display name.

**N16 — Peek tokens are held by agents that aren't peeking, and `releasePeek` has zero call sites** · noticeable · `src/ai/squad.js:97` · confidence medium
Root cause: `requestPeek` called unconditionally every frame (agent.js:525) but the answer latched only on timer expiry; a token is never freed on state change/death (grep: `releasePeek` defined at 104, never called). 21-54% of holders not peeking; ~8-9s of held fire per 60s of 6-agent combat while at cover with the player visible (`wantFire` gates on `peeking`, agent.js:536).
Fix: move `requestPeek` inside the `peekTimer <= 0` branch; call the already-written `releasePeek` on stop/leave/death. Wire-the-existing-function case.

**N17 — Failed destinations re-requested every frame; PATROL silently burns its route while failing** · noticeable · `src/ai/agent.js:401` / `383-389` · confidence medium
Root cause: `_goTo` failure clears `hasMoveTarget`, which is both callers' re-entry condition — up to 5,918 A* requests/90s, 51-93% known-failures; one agent asked for one destination 1,673 times. Independent visible effect is the PATROL branch only: `if (this.pathPending) break;` (382) guards deferral but not failure, so patrolIndex advances at frame rate.
Fix: cache the failed destination cell with a 1-2s retry timer; don't advance patrolIndex on a false return (mirror the existing pathPending guard).

**N18 — Explosions shove rigid bodies (spent brass) through walls; only the ragdoll loop is occlusion-tested** · cosmetic · `src/physics/index.js:775`
Root cause: docstring at 767-768 promises occlusion; ragdoll loop tests it (784), body path doesn't; `applyRadialImpulse` is pure distance (rigidbody.js:263-276), massless brass takes full delta-v (measured dv 2.9-3.7 m/s through cover, 11/11 occluded placements shoved).
Fix: skip bodies failing `lineOfSight(pos, bodyPos, MASK.EXPLOSION)` in `explode()`, matching the ragdoll branch.

**N19 — Reinforcement waves spawn a squad into capture runs, defeating the garrison suppression the capture path exists for** · cosmetic (dev-facing) · `src/ai/index.js:867` / `:88`
Root cause: `this.reinforce = true` unconditionally, despite the comment "Off in capture runs"; with populate() correctly skipped, `alive===0` from frame one and the 6s timer fires. Reproduced: 3-man squad at t=6s in an empty capture level.
Fix: `this.reinforce = !ctx.config.deterministic || this.forcePopulate;` — the exact gate already written at index.js:812. 1 line.

## 2. PRIORITY CHANGES to existing rows

- **2.3 (stuck recovery + pathPending starvation) — SPLIT and ESCALATE the first half to #1 game-breaking.** New evidence: recovery at agent.js:692-697 re-requests a byte-identical destination 699/700 fires; individually agents skate in place up to 62s; at whole-garrison scale, 2/2 free-running sessions had ALL SIX agents permanently immobile (0.00m/10s, `blk:true`) from ~2-3 min in, and in 1/2 the level went totally silent for 166s (dFire=0). The walk animation runs off desired speed (agent.js:945-956) so they visibly march in place. The **starvation half is REFUTED as player-visible**: deferral leaves the existing path intact (agent.js:594-599), max unbroken pathPending 1.54s across 5 sessions even at 49.7% budget-cap frames — downgrade to tech-debt (one-line budget refund on O(1) rejects at index.js:910, optional).
- **3.7 (flanking off after opening seconds) — root cause now nailed, confirmed independently by 3 probes.** `agent.js:547` `this.grenadeCooldown < 0 === false` parses as `(cd<0)===false`, requiring cd≥0; the timer decays unclamped (273) and resets only on the once-per-life throw (790). A/B proof: forced cd=-1 → 0 flanks/3600 frames; cd=+30 → 9. Corrected scope vs earlier belief: each agent gets its spawn window (9-22s) plus one post-throw window (16-34s), then never again for that life/wave. Fix: clamp `Math.max(-1, cd-dt)` and rewrite the predicate on `hasGrenade` (or decouple flanking from grenade state entirely). Pairs with N11.
- **2.2 (false killfeed row) — confirmed, mechanism fully specified, keep severe.** Ordering proven (registry.js:107 insertion order, ai before ui via main.js:69-70), `_lastKillAt` read at ui/index.js:231 before written at :204; fires on 4/4 normally-paced kills, suppressed only under 0.3s spacing. Fix path: thread `by` onto `actor:death` from `Agent.die()` — same wiring style as RC-1.
- **2.4 (dead agents never removed, no AI respawn) — likely STALE, verify and close.** Probe p6 observed corpse retirement (`retired:6`) and `_updateReinforcements` (ai/index.js:868-880) firing populate() on a cleared garrison (`waves:1`, fresh 3-man squad). Residual: emptied Squad objects accumulate one per wave (refuted as player-visible; tech debt).
- **3.14 (cover lean computed and discarded) — half-close.** The dead `peekSide` write itself produces no visible outcome (median post-peek displacement 0.005-0.057m, but nothing reads it); the HARM from that code is N12 (coverPos overwrite). Re-point 3.14 at N12 or close it as superseded.

## 3. UNRESOLVED

- Path-budget charged on O(1) cross-component rejects (ai/index.js:910): real, reproduced (2,426 deferrals @31fps), but no attributable wrong outcome. One-line refund fix if touched anyway.
- EV1 showed ~1,000 of 1,778 path failures were `nearest()` returning -1 (no walkable cell within 8 rings) — a separate, uncharacterised failure class, not the cross-component one. Nobody has looked at it.
- Agent-agent interpenetration (min pairwise 0.08m) is real but survives active avoidance; the proposed avoidance fixes were refuted — the actual absence is agent-agent collision in the character controller. Disputed ownership (physics vs AI), unmeasured fix.
- Latent spawn mismatch: index.js:590 `nearest(...,6,1.4)` vs index.js:531 `nearest(...)` defaults can disagree; not firing on this level (3/3 cold boots clean, `spawnFellBackToAnchor=0`).
- N16 and N17 are confidence:medium — mechanisms code-proven, magnitudes seed/scenario-dependent.
- Total-silence rate for the garrison wedge is 1/2 in this pass (~3/4 combined with earlier data) — depends on whether wedged agents happen to hold LOS.
- Dead `grenade` keybinding (input.js:24): real dead code, refuted as player-visible (the key is never advertised in menu.js:90).
- All cover/LOS rates are properties of ONE level layout (capture fixes the world seed); untested everywhere: RETREAT state, agent death mid-peek, moving/shooting player, scoreLimit-75 path, gamepad/menu input, EventBus/heap growth.

## 4. WHAT WAS NEWLY REACHABLE

16 of the 19 new rows could not have existed as observable bugs before RC-1/RC-3, because the garrison could neither move, fight, nor throw:

- **Unlocked by RC-3 (agents can finally move):** N3 (island stranding — you cannot strand an agent that never walks or vaults), N7, N8, N10, N12, N13, N16, and the 2.3 escalation (a stuck recovery is unobservable when nothing ever paths). The entire cover/peek/suppression state machine ran for the first time.
- **Unlocked by RC-3 → grenades actually thrown:** N4 (marker), N11, N14, N18 — the marker freeze and the wall-shove had literally never executed with a live grenade in flight.
- **Unlocked by RC-1+RC-3 → real two-sided combat and real player deaths:** N1, N2, N6, N15 — the match-end lock states need the AI to be capable of killing the player near the clock edge; before the fixes the player effectively couldn't lose.
- **Unlocked incidentally:** N19 (reinforcements had never run against a suppressed garrison), N9 (self-suppression is the same missing-source class as RC-1 itself — the third instance of "event emitted without identity, consumer applies it blind," after damage:dealt and explosion source).
- **NOT newly reachable (pre-existing, simply never caught):** N5 (multi-capsule damage), 2.2 (false killfeed row), N17 (frame-rate re-request).

The lesson in the numbers: two blocking defects concealed ~16 independently player-visible bugs, including three game-breakers, across five subsystems that all read as "fine" while the AI was paralysed. Absence of observed failure in a system that cannot exercise its paths is evidence of nothing.