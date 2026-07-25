# Claude of Duty — Prioritised Fix Queue

Consolidated from 6 static + 3 live adversarial verification passes. All rows below survived independent re-verification unless flagged in UNRESOLVED. File paths relative to `/Users/matthewrini/Documents/GitHub/Matt Shumer Claude of Duty/original/`.

---

## Root-cause dedupe map (read first)

Three root causes account for 11 of the surfaced symptoms:

| Root cause | Surfaces as |
|---|---|
| **RC-1: `damage:dealt` from physics carries no `source`** (physics/index.js:732) | AI team wipes itself in ~20s · player credited score/XP/killfeed for AI self-kills · killfeed attacker always "ENEMY"/"YOU" hardcoded |
| **RC-2: death/respawn loop unwired** (`player:death` 0 subscribers, `respawn()` 0 callers, `setMatch()` 0 callers) | dead-flag latches forever · invulnerable-at-0-HP · permanent desaturation · ADS permanently off · `scoreThem` frozen at 0 · match clock frozen at 10:00 · heal() can mint 100-HP-but-dead |
| **RC-3: nav grid has ~800 disconnected components and nothing checks reachability** (nav.js:414) | 98% of cover picks unreachable · 96% of path requests fail · pathPending starvation saturates A* budget · agents spawn on 10–21-cell islands · stuck-recovery loops on same target · flank `_goTo` almost always refused |

---

## BATCH 1 — core loop / game-breaking, mostly wiring existing code

### 1.1 Thread shooter identity through physics damage, add team guard, gate player credit
- **Root cause:** RC-1. `physics/index.js:732-739` emits `damage:dealt` with no attacker; `ai/index.js:320` applies it with no team check; `ui/index.js:177-203` credits ANY non-player-target kill to the player. `Agent.team` (agent.js:182) is written, never read. Live-measured: 25/25 agent damage events were same-team; 5 of 6 enemies dead by t=20s with player idle; `scoreUs:5` with 0 shots fired.
- **Effect:** the match plays itself — garrison self-destructs, player gets phantom hitmarkers, "+150 XP · HEADSHOT" banners and score 5 while standing still with a full mag.
- **Fix (wiring):** the AI→player branch already does this (`source: agent`, ai/index.js:653). Thread the same `source` through `phys.fireBullet` → `emitImpact`; in ai handler: `if (e.source instanceof Agent && e.source.team === a.team) return;`; in ui, replace "target is not player" with `_isPlayerSource(e.source)` (mirror `_isPlayerTarget` at ui/index.js:257).
- ~15 lines. Fixes 3 game-breaking symptoms at once.

### 1.2 Nav connectivity: component IDs + reachability filter in cover pick, findPath, and spawn
- **Root cause:** RC-3. `CoverMap.build()` (nav.js:414) pushes cover points with zero connectivity test; `pick()` (nav.js:436-482) scores by straight-line distance only. Measured live: ~800 components, 23% of walkable cells on islands, 3811/3872 cover picks cross-component, findPath 99 ok / 2719 fail (2718 cross-component), two of six agents spawned INSIDE tiny islands.
- **Effect:** enemies stand in the open with weapons lowered, jog in place, pick-and-drop the same unreachable cover every frame. The firefight visibly stalls.
- **Fix (reuse existing adjacency):** flood-fill once at end of `NavGrid.build()` using findPath's own adjacency rule, store component id per cell (Int32Array beside `flags`); one `if (comp[point] !== comp[agent]) continue;` in pick, same early-out atop findPath; `populate()` rejects spawn cells whose component < floor.
- ~40 lines. Removes most of the demand causing the pathPending starvation (2.3) too.

### 1.3 Wire the death→respawn loop; make heal() clear `dead`
- **Root cause:** RC-2. `health.js:126` emits `player:death` — zero subscribers (EventBus verified exact-key, no wildcard, registry.js:84-118). `player.respawn()` (player/index.js:657) fully implemented, never called. `heal()` (health.js:135-137) restores HP without clearing `dead`. Live-reproduced: 0 HP → invulnerable (`health.js:81`), regen off (health.js:168), hitbox off (player/index.js:301), ADS off (:308), desaturation pinned (health.js:190), and heal(100) produces 100-HP-but-dead.
- **Effect:** at 0 HP nothing happens; screen locks into full desat + vignette + max heartbeat forever; only reload recovers.
- **Fix (wiring):** subscribe to `player:death` (ui or a small match module), call `player.respawn(index)` after a delay — it already does `health.reset(true)` + teleport. Add `if (this.value > 0) this.dead = false;` to `heal()`.
- ~10 lines.

### 1.4 Minimap blips: read `ai.agents`, not the nonexistent `getHudActors`/`actors`
- **Root cause:** `ui/index.js:551` calls an API that doesn't exist (AI exposes `agents`, ai/index.js:70). Live: `blipCount:0` with 6 live agents.
- **Effect:** minimap permanently empty of contacts, including while being shot.
- **Fix:** `const list = ai?.getHudActors?.() ?? ai?.agents ?? null;` — the loop below already reads `position/alive/heading`, all present on Agent.
- 1 line.

### 1.5 Grenade danger warning: call the existing `ui.spawnGrenade` from the existing throw site
- **Root cause:** `AiSystem.throwGrenade` (ai/index.js:672-697) spawns a live 120-damage/6.5m grenade and emits nothing; `ui.spawnGrenade` (ui/index.js:350, marker + 'grenade_warn' beeps at markers.js:177 / foley.js:722) has zero gameplay callers.
- **Effect:** player killed by a completely unsignalled explosion; only cue is a 5cm sphere.
- **Fix:** at end of throwGrenade: `this.ctx.peek('ui')?.spawnGrenade?.(from, 2.35);` (better: pass the body so the marker tracks it).
- 1–3 lines.

---

## BATCH 2 — severe but contained

### 2.1 Aim convergence: rounds travel parallel to camera axis, never through the crosshair
- `weapons/index.js:373-391`: dir copied from camera forward, origin from muzzle, no convergence. Verified analytically to 0.6mm against live measurement. **Corrected numbers:** ADS = 6.7cm low at every range (exactly optic-over-bore — the weapon has no zero); hip = 8.7cm right + 13.6cm low (dominates inside ~5m, swallowed by spread beyond).
- **Effect:** every ADS group centres low, costs head shots (head capsule r=0.098); shots through windows/over cover >0.8m hit the sill.
- **Fix:** in tryFire after line 373, raycast from camera along `_camDir`, re-aim `_dir` from muzzle to hit point BEFORE the spread cone at 376-384. Spread/recoil/ballistics untouched. ~6 lines.

### 2.2 Killfeed prints a false "ENEMY killed OPERATOR" row on every kill
- `ui/index.js:219-226`: the 0.3s dedup guard is unreachable by construction — `actor:death` fires synchronously inside ai's `damage:dealt` handler, which runs BEFORE ui's handler sets `_lastKillAt` (registration order re-derived: ai before ui; no ordering makes it correct). Payload has no `by`, Agent has no `.name`. Live: 5/5 kills produced both rows.
- **Effect:** every kill prints two rows, the second falsely announcing the player's death; halves feed capacity (pool of 6).
- **Fix:** carry attacker + display name on `Agent.die()`'s payload; set the credit flag where the kill is detected (ai/index.js:326) — or have ui's `actor:death` handler skip Agent deaths and reserve that row for the player. ~8 lines.

### 2.3 pathPending starvation + useless stuck recovery (fail-safes; mostly relieved by 1.2)
- `ai/index.js:113` budget of 2 solves/frame vs measured 2.4 requests/frame of mostly-unreachable targets; the drop-unreachable-cover branch is explicitly gated on `!this.pathPending` (agent.js:500-509) so it never fires while starved (agent 6: 1086 consecutive pending frames). Stuck recovery (agent.js:691-698) fires correctly at 1.1s (verified — original claim it rarely fires was refuted) but repaths to the SAME target; agent 2 played run animation with <2mm movement for 93.5% of a 70s run.
- **Fix:** deadline on `pathPending` (~0.5s via existing repathTimer machinery) → drop cover, shoot from here; stuck recovery clears `cover`/`hasMoveTarget` and picks a DIFFERENT destination. ~10 lines.

### 2.4 Dead agents never removed, no AI respawn — level permanently empties
- `populate()` runs only at boot (ai/index.js:164/729); no `agents.splice` anywhere; `deadTime` ticks but feeds only a debug log (ai/index.js:745). (Ragdoll DOES sleep — solver-cost claim refuted.) Combined with RC-1 the level is empty in ~20s.
- **Fix (both ends exist):** in the `deadTime` branch, after a fade window call `a.dispose()` + splice; call existing `populate()` to bring a fresh squad. ~10 lines.

### 2.5 scoreThem++ and match clock tick
- `scoreThem` (ui/index.js:120) has no increment path — the event that would feed it is the now-wired `player:death` (1.3). `timeLeft: 600` (ui/index.js:121) never decremented; `setMatch()` (:355) has zero callers; DOM verified frozen at "10:00".
- **Fix:** subscriber doing `this.state.scoreThem++` (mirror scoreUs at :201); `s.timeLeft = Math.max(0, s.timeLeft - dt)` in lateUpdate. 2 lines. Depends on 1.3.

---

## BATCH 3 — noticeable polish

### 3.1 Ammo counter clamps away the chambered round — first shot after every reload doesn't decrement
- `weapons/index.js:269` `h.ammo = Math.min(a.mag, a.magSize)` collapses 31→30 and 30→30; spawn is 31 (weapons/index.js:159-160); ui only rewrites text on change so the punch animation is also suppressed (ui/ammo.js:101-107). **Fix:** display `a.inMag` (already exposed at :210) so the chambered round is never counted. 1 line.

### 3.2 Dry-fire is silent on held trigger and on empty reserve
- `weapons/index.js:345-350` dry branch emits nothing; audio's dryfire voice is fully built and reachable (audio/index.js:543-545). Auto-reload compensates only FRESH presses (`firePressed` is an edge, core/input.js:229) — held-trigger-through-last-round and zero-reserve are permanently silent. **Fix:** add `empty: true` to the preallocated `_firePayload` and emit `weapon:fire` from the dry branch; audio side needs zero changes. ~5 lines.

### 3.3 Every hit/headshot/damage cue plays twice (+4.6 dB, double voice slots)
- ui (ui/index.js:294/312) and audio (audio/index.js:704/714) both subscribe to the same events and fire the same voices; live-verified two `_playDry` calls per event. Phase-coherent sum, so level error not flam (original's "phasey" claim corrected). **Fix:** delete the redundant `this.sfx(...)` in `UiSystem.hitmarker`/`hurt`; keep ui-side sfx only for cues audio can't derive (grenade_warn, regen, lowhealth). ~4 deletions.

### 3.4 Heartbeat: audio's `_health` only updates on damage, so the low-health loop never stops
- `audio/index.js:713` writes `_health` only in `_onDamageTaken`; regen never updates it → once under 34 HP the heartbeat loop (audio/index.js:263-268) plays forever at full health. (Cross-confirmed by two reviewers.) **Fix:** update `_health` from the player HUD snapshot in audio's update, or subscribe to a heal/regen signal. See also UNRESOLVED U-8 (a third heartbeat clock finding arrived truncated).

### 3.5 Stair descent: `_sweepDown` never passes the documented 0.6 radiusScale
- `character.js:169` calls `_sweepDown(want + snap)` with no scale; measured live on a real in-level staircase: 36% airborne frames, 4.23 m/s landing impacts (vs 0% / 0 with 0.6) → stuttering bouncing descent, footsteps cut out, repeated camera land-dips. **Fix:** `this._sweepDown(want + snap, 0.6)` — matches what `probeGround` already does. 1 line + selftest assertion.

### 3.6 AI `slopeLimit` passed in degrees, interpreted as radians
- `ai/agent.js:152` passes `slopeLimit: 48` where the player passes `48 * (Math.PI/180)`; CharacterController takes radians (character.js:40/76) → AI cosSlope = cos(48 rad) = −0.80, limit inert in the wrong direction. Live-confirmed. **Fix:** multiply by `Math.PI/180`. 1 line.

### 3.7 Flanking permanently off after the opening seconds
- `agent.js:547` gate requires `grenadeCooldown >= 0`; timer starts 9–22s, decrements unclamped forever (agent.js:273), grenade is one-shot. Measured: 0 flank frames in 70s, all six cooldowns negative. **Fix:** clamp cooldown at 0 and decide the gate's intent explicitly. 1–2 lines. (Also gated behind `_goTo` success → depends on 1.2.)

### 3.8 All six enemies spawn within ~13m; four of five eligible spawn points unused
- `ai/index.js:489-501` both squads anchor to the two FARTHEST points, which are 8m apart. Also feeds the friendly-fire wipe speed (one corridor). **Fix:** pick each further anchor as farthest-remaining that is also ≥N m from chosen anchors (spacing idea already in CoverMap.pick, nav.js:465-470). ~5 lines.

### 3.9 Sky has zero motion-blur velocity — sharp clouds behind a fully smeared street
- `motionblur.js:53-60` has no background branch; sky excluded from prepass (dome.js:348) so its velocity is (0,0); TAA already has the exact reprojection branch needed (taa.js:130-137). Verified with opened pixels (dbg_velocity.png: sky exactly black). Tile-max also drags a smeared building fringe into the sky along rooflines. **Fix:** copy TAA's 8-line far-plane reprojection into BLUR; matrices already available. Shader-only, no new buffers.

### 3.10 Viewmodel takes world screen-space AO (+ interior gate coupling)
- `render/index.js:1391` clears only `feat.y` for the gun; AO (feat.x) stays on and samples the WORLD buffer behind the gun (materialpatch.js:281-283). Measured reversible 5% luma A/B; interior-gate trace shows corners can cut the gun's indirect to ~43% for the wrong reason. **Fix:** clear `feat.x` alongside `feat.y`, restore with the existing prevFeat scaffolding. ~2 lines.

### 3.11 Auto-exposure meters the viewmodel — ~0.12 EV pump on weapon switch
- `render/index.js:1480-1494` composites the gun then meters the result; measured 0.158 EV swing on switch vs 0.041 control. Constant 0.26 EV bias is absorbed by shipped exposureKey and is NOT a defect; only the coverage-dependent pump is. **Fix:** meter the pre-composite `color` (keep a ref before step 14). ~3 lines — note ordering is documented deliberate for muzzle-flash metering (see U-4).

### 3.12 Enemy muzzle flash within ~2m renders in the viewmodel layer — floats mid-air, draws through walls
- `fx/index.js:396-399` infers first-person by distance; enemy fire payload carries no ownership. Corrected mechanism: sprites are at correct world positions but PROJECTED by the 60° view camera vs 80° world (≈200px displacement at 1920w) and composited with no depth. **Fix:** `own: true` flag on weapons' `_firePayload`; `const firstPerson = e.own === true;` with distance as fallback. audio/index.js:546 already models this convention. ~4 lines.

### 3.13 `onNearMiss` called on a method that doesn't exist — near-miss suppression dropped
- `ai/index.js:638` `player?.onNearMiss?.(miss)`; no definition anywhere (live: `typeof` undefined). Suppression channel fully built (player/index.js:612 → health.js:139). **Fix:** implement the one-liner passthrough next to `addSuppression`. See U-1 (possibly deliberate).

### 3.14 Cover lean computed and discarded — soldiers never peek
- `agent.js:527-533` writes `peekSide` (zero readers repo-wide) and `coverPos`, but the at-cover branch pins the agent (`desiredSpeed=0`); 0.62m offset < 0.85m atCover tolerance so movement never triggers. Measured 20 peek events, 18 with zero displacement. **Fix:** drive movement to the computed peek position and run LOS from there. Moderate (~15 lines). Causal link to "agents don't fire" was narrowed — see U-6.

---

## DEFERRED / LATENT (no player-visible effect today, or owner-parked territory)

- **D-1. slopeLimit locomotion enforcement inert** (character.js:433 wide fallback accepts ny>0.15): verified ZERO reachable effect — level's 37,440 collision triangles contain no slope between 4° and vertical. Fix when sloped collision is ever added; finish the selftest that claims a 70° ramp (selftest.js:69 builds only the 30°).
- **D-2. A\* maxNodes 6000 cap** (nav.js:244): loses ~33% of achievable routes offline, but live attribution showed 2718/2719 failures are cross-component. Re-measure AFTER 1.2 lands; only then decide.
- **D-3. Six dead tuning constants** (tuning.js:251/275/281/286 — wallPad, swayScale, HEALTH.effect.*): nothing renders wrong; lowhealth.js hardcodes its own coefficients. Plumb or delete when touching that file.
- **D-4. Viewmodel cascade hand-off dead code** (render/index.js:1387-1395): owSunShadow's 0.999 gate can never match the rig lights; whole block changes zero pixels. Delete or repoint owSunDirView at the rig key — but see U-3 (rig may be deliberately sun-independent). Render-architecture adjacent; not batch 1 material.
- **D-5. sky.setWeather/setTimeRate zero callers** (sky/index.js:427): entire night/weather model reachable only from dev harness. Likely a scope decision (U-5). If unwanted, just remove from the API header.
- **Perf architecture: nothing in this inventory requires it; owner has parked it. No perf rework queued.**

---

## UNRESOLVED / LOW CONFIDENCE / DISAGREEMENTS

- **U-1. onNearMiss (3.13, medium):** the `?.()` call is written defensively — possibly a deliberate stub. Audio DOES play a whizz independently, so the player isn't cueless; only the suppression pool is unfed.
- **U-2. Muzzle-flash ownership (3.12, medium):** reachability verified (~2m trip distance), but no pixels of the misprojected flash were ever opened; magnitude is computed, not observed.
- **U-3. Viewmodel never shadowed (D-4, medium):** the view rig is DOCUMENTED as deliberately world-sun-independent (index.js:262-267). Reviewers could not determine whether "gun never darkens in shade" is a defect or a choice. Also latent: a specific camera pose CAN satisfy the 0.999 gate → abrupt wrong shadow pop (reasoned, not observed).
- **U-4. Exposure ordering (3.11, medium):** metering-after-composite is documented deliberate so the muzzle flash meters/blooms (index.js:1477-1479). The fix must preserve that or accept losing it.
- **U-5. Frozen sky (D-5, low):** fixed time/weather is an ordinary scope decision; reported only because it matches the integration-gap signature.
- **U-6. Peek-lean causality (3.14):** the lean IS discarded (proven), but the original claim that it causes agents not to fire was NOT established — targetVisible was true at all 20 measured peek moments; the silent agents were silent for nav reasons (1.2).
- **U-7. Spawn bunching (3.8, medium):** bunching measured; the original "empty map for two-thirds of a walk" claim was corrected — patrols do reach ~30m out.
- **U-8. TRUNCATED INPUT:** the ui-audio reviewer's finding "Three independent heartbeat clocks; two drive audio simultaneously at low health" (audio/index.js area) arrived cut off mid-record in my input — title and kind only, no evidence/severity/fix received. Not dropped: fold into 3.4's fix pass and re-verify the third clock (ui/index.js:95 `onBeat` vs audio's loop vs health's pulse) before closing.
- **Reviewer corrections already absorbed (no action):** hip-fire miss is RIGHT-and-low not left; ADS miss is 6.7cm not 16cm; motion-blur original readback evidence was impossible (RG16F readback fails) but the conclusion was re-proven with opened pixels; ragdolls DO sleep; stuckTimer DOES reach threshold; agent 4's silence was island-stranding, not pathPending; "5 of 8 spawn points unused" is actually 6 of 8. Runtime AI numbers vary per session (RNG seeded from Math.random) — treat cited figures as one session, not constants.

---

## What this codebase teaches — recurring failure CLASSES

1. **The last-mile wiring gap.** Every subsystem builds both ends of a channel and nobody writes the one line connecting them (`player:death`→respawn, throwGrenade→spawnGrenade, dry-fire→dryfire voice, agents→minimap). The pattern: the PRODUCER and CONSUMER were authored by different "sessions" that each trusted the other side existed. Detection heuristic: grep every `emit(` for a matching `on(`, every public-API-header method for a caller — an exact-key EventBus makes this mechanically checkable.

2. **Payload contract drift between branches of the same event.** The same event name carries different shapes from different producers (`damage:dealt` with/without `source`; `actor:death` without the `by` the consumer reads). One branch got the field, its sibling didn't. Consumers then infer identity from what's present ("target isn't player ⇒ I did it"), which is wrong the moment a third party exists. Class: identity/ownership must be an explicit payload field, never inferred from distance, absence, or ordering.

3. **Doc-block as wish, code as reality.** Doc comments and parameter names describe behaviour the code doesn't implement (the `radiusScale` a call site never passes; `slopeLimit` accepted then bypassed by a fallback; a selftest comment promising a 70° ramp that's never built; tuning.js claiming to hold "every number" while shaders hardcode their own). The doc is written first as intent and the wiring step is skipped; later readers trust the doc.

4. **Guard ordered before its dependency.** Dedup/credit logic reads state that is only written LATER in the same synchronous dispatch chain (`_lastKillAt` checked in a handler that runs before the handler that sets it). Synchronous nested emits + registration-order dispatch make "check then set" across handlers a landmine. Class: cross-handler temporal coupling through mutable shared state.

5. **Local validity, global invalidity.** Cover picking, A*, spawn placement, and stuck recovery are each individually correct but no one owns the GLOBAL invariant (the nav graph is connected / the destination is reachable). Every consumer assumes someone else validated reachability. Class: missing shared invariant with no owner — each module's precondition is another module's unwritten postcondition.

6. **Unit/type mismatch at subsystem seams.** Degrees passed where radians are consumed (agent slopeLimit); the same number means different things on the two sides of a call and nothing asserts range.

7. **State that latches without a release path.** `dead`, audio `_health`, `grenadeCooldown`, boltHold: flags/timers written on one transition with the reverse transition never wired (or unclamped drift). Every persistent flag needs its clearing site named at write time.

8. **Inferred context instead of declared context.** Distance-based "is this first-person?" (fx, audio), target-based "did the player do this?" (ui). Heuristics stand in for one boolean the producer could have set. They fail exactly when the world gets crowded.

9. **Two owners for one output.** ui and audio both sonify the same events; three heartbeat clocks. Nobody decided which module owns a cue, so both play it. Class: missing ownership decision, not missing code.

10. **Meta-lesson for reviewing such codebases:** first-pass findings were directionally right but quantitatively wrong at a high rate (miss direction flipped, magnitudes 2x off, impossible GPU readbacks, misattributed agents). Adversarial re-verification changed the fix priority in several cases and refuted 3 of 7 render findings outright. The verification pass is not overhead — it is where the fix queue's ordering actually comes from.