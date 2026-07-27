# OPEN LOOPS — Claude of Duty (fork)

Ledger of known defects and unfinished work. A row closes only when its **closes-when** check
passes against real artifacts — never because someone said it was done.

Upstream ground truth for comparison: `../original` (read-only, never commit there).

---

## CLOSED — Batch 1 (verified 2026-07-25)

| # | What | Root cause | Closes when | State |
|---|---|---|---|---|
| 1 | Player hits 0 HP and never dies; becomes permanently invulnerable and un-healable | `player:death` emitted with **zero subscribers**; `respawn()` implemented, never called | `tools/verify-match.mjs` passes death→respawn→damage-again | **CLOSED** — 11/12 asserts pass; health 0→dead→respawn 100→damaged to 75 |
| 2 | Match clock frozen at 10:00 for the entire session | `ui.setMatch()` implemented, never called; `timeLeft: 600` never ticked | clock decrements in `verify-match.mjs` | **CLOSED** — 599.98 → 597.98 |
| 3 | Enemy team score never leaves 0 | `scoreThem` had a render path, no increment path | `scoreThem` increments on player death | **CLOSED** — 0 → 1 |
| 4 | Minimap draws no blips of any kind | **Contract mismatch**: UI calls `ai.getHudActors()` / `ai.actors`; AI exposes `ai.agents`. Neither name existed → `_collectBlips()` bailed on a null list | blipCount > 0 in normal (non-capture) play | **CLOSED** — 6 agents → 6 blips, first at (−18.3, −30.6) kind `enemy` |
| 5 | Ships at `ultra` (~14fps) with no adaptive scaler | `DEFAULTS.quality: 'ultra'`; only `setQuality` caller is the settings menu | default measured best-of-preset | **CLOSED (partial)** — default now `medium`; see loop #6 |

| 6 | No way to silence the game — audio played with no mute control anywhere | `setMasterVolume()`/`setBusVolume()` implemented and correct; settings menu had quality/sensitivity/FOV and **no audio section**, so nothing ever called them | mute button + `M` key toggle master volume and survive a reload | **CLOSED** — `src/ui/audiotoggle.js`; verified 0.95→0, no drift, persisted mute applied the instant the graph starts |

**Fix:** new `src/match/index.js` (`MatchSystem`) owns the seam — round clock, `scoreThem`,
death→respawn cycle. Plus `ai.getHudActors()` accessor and the measured quality default.
Nothing gameplay-related was re-implemented; existing correct code was connected.

**Sub-defect found while building the mute** (worth its own note): the Web Audio graph is not
created until a user gesture and comes up at the mixer's own default gain, so a mute chosen before
that moment was silently discarded and audio started anyway — button still reading MUTED. Fixed by
`AudioToggle.sync()` from `UiSystem.lateUpdate`, which re-asserts on drift. Init-order-independent.

---

## ⛔ WORK STOPPED DELIBERATELY — 2026-07-25

**~57 rows below and in the two fix queues are KNOWN-OPEN, not abandoned.**

Reason: the goal was always better skills (especially for Codex); fixing this demo was
instrumental. The core loop is fixed and verified — death/respawn, friendly fire, nav connectivity,
agent mobility, corpse lifecycle, match state. What remains is polish on a tech demo nobody is
shipping (e.g. *"43% of grenade throws hit the wall in front of the thrower"*).

Two facts made continuing negative-value:
1. **The thesis was proven** — 5+ integration-gap defects in the original, **4 introduced by me**
   while documenting the class. Instance #10 carries no new information.
2. **My marginal fix now costs more than it returns** — I introduce these bugs at roughly the
   original authors' rate; only the gate and the suite catch them.

The transferable value was extracted instead: **`~/.codex/skills/unwired-seams/`** (symlinked into
`~/.claude/skills/`) — the wiring gate, generalised, with a planted-defect self-test and the case
study. That runs on any repo, including Matthew's Codex-built games.

**To resume:** `fork/FIX-QUEUE.md` (24 rows) and `fork/FIX-QUEUE-DELTA.md` (19 rows) are complete
and prioritised. Highest remaining: N5 (one round deals 2–5× listed damage through stacked hit
capsules, up to 163 HP from a 33-damage round), N7 (agents weapon-down up to 63s in the open),
2.2 (false killfeed row per kill), 2.1 (ADS lands 6.7 cm low).

10 commits sit on `fix/core-loop`, **unpushed by choice**. Full suite green.

## OPEN

| # | What | Evidence | Closes when | Owner | State |
|---|---|---|---|---|---|
| 6 | **Geometry-bound performance.** No quality preset makes 1080p playable. Presets scale shadow res and post passes, not submitted geometry — draw calls/tris barely move (ultra 1395/10.3M vs medium 1146/8.4M). Best measured: 21fps @1080p | `tools/perf.mjs` matrix in `src/main.js` header comment | 1080p ≥ 60fps median at the default preset | Claude | **OPEN — DEFERRED by Matthew** (batching/instancing is explicitly out of scope for now) |
| 7 | **Boot takes ~60s warm, longer cold.** Shader prewarm alone measured 46.8s (34 → 170 programs) | `[boot] prewarm {ok:true, ms:46795}` | cold boot to `__READY__` under 15s | Claude | OPEN |
| 8 | `player:health` emitted every 0.1s with **zero subscribers** | `grep -rn "player:health" src/` → one doc comment only | either consumed or removed | Claude | OPEN — low impact (`player:state` carries health and *is* consumed) |
| 9 | `ui.setObjectives()` implemented but called **only from `ui/demo.js`** (the screenshot mock) | `grep -rn setObjectives src/` | objectives driven in real play, or the API removed | Claude | OPEN |
| 10 | Killfeed names are hardcoded placeholders (`YOU` / `ENEMY` / `OPERATOR`); two rows can be byte-identical | `src/ui/index.js` killfeed push | agents carry identities | Claude | OPEN |
| 11 | EV100 auto-exposure metering measurably inert — full-screen flash moved frame mean 23% while distant pixels moved 0.16%; no adaptation ramp | phase-1 forensics on 224 native frames | measured adaptation ramp after a luminance step | Claude | OPEN |
| 12 | Red-team sweep in flight (`wf_31b18790-33e`). 6 static reviewers + 6 adversarial verifiers **DONE: 53 raw findings → 42 verified (~21% refuted)**. Awaiting 3 live behavioural drivers + the inventory synthesiser | workflow journal, 12/16 results | prioritised fix queue merged into this ledger and Batch 2 started | Claude | **IN PROGRESS — this is the next action on return** |
| 13 | 5 of 59 red-team agent scripts launch Chromium without `--mute-audio` (`av-probe1–4`, `vd0_probe`) | audit of `scratchpad/rt/*.mjs` | all agent-authored browser launches muted | Claude | OPEN — root cause was my own prompt omitting the arg; see the global NOISE LAW |
| 14 | **A runbook expectation was bound to the wrong instrument.** `HANDOFF.md` §4 said `node tools/gate-wiring.mjs --root ../original` should report **24**. Measured: **17**. The 24 is the *generalised skill* gate's number (different tool, different CLI, also scans `tools/`): skill gate → original 24 / fork 21; project gate → original 17 / fork 14 | both instruments run 2026-07-26; project-gate delta 17→14 equals exactly the three closed seams (`player:death`, `respawn()`, `setMatch()`) | expected values in any runbook name the exact instrument that produced them | Claude | **CLOSED 2026-07-26** — `HANDOFF.md` corrected, both instruments recorded side by side |
| 15 | **`unwired-seams`' non-vacuity assert is the weakest form and does not bind.** The self-test computes `planted = 4` and prints it, but asserts only `found === 0`. A gate that *invents* findings passes 10/10 | reproduced: sabotaged a scratchpad copy of the gate to push one fabricated orphan event; self-test printed `gate reported 5 finding(s), 4 planted` and still exited **0** with `10/10 PASSED` | self-test asserts the found set **equals** the planted set, and the sabotaged copy is demonstrated RED | Claude | **CLOSED 2026-07-26** — binding form shipped (skills `a337dee`). Real gate 14/14 green; **sabotaged gate now exits 1** with `FAIL non-vacuous (binding): found 5 of 4 planted; UNEXPECTED spurious:falsepositive`. Second gap found by `prove-red` in the same pass: the allow-list load had zero coverage — 4 asserts added, kill rate 6/12 → 7/12 |

## OPEN — found in `original` while harvesting B2 (RECORDED ONLY, queue stays stopped)

These were found reading `original/src/` for the `procedural-game-assets` skill. They are **not**
being fixed — the fix queue is stopped by decision. Recorded so they are not lost, and documented in
the skill's honest-gaps section so nobody lifts them.

| # | What | Evidence | Closes when | Owner | State |
|---|---|---|---|---|---|
| 16 | **Operator precedence disables flanking.** `agent.js:547` reads `this.grenadeCooldown < 0 === false`. `<` binds tighter than `===`, so it is `(grenadeCooldown < 0) === false` ≡ `grenadeCooldown >= 0`. `agent.js:273` decrements it **unclamped**, so it goes permanently negative once ready — meaning the gate reads "grenade NOT ready" and an agent can only flank while its grenade is on cooldown. Compare `agent.js:570`, which correctly uses `<= 0` | verified by evaluating the expression: `node -e 'console.log(5 < 0 === false)'` → `true`, so the parse is `(5<0)===false` | condition expresses the intended "grenade is ready", or the clause is removed | — | OPEN in `original` — **not scheduled**; documented in `procedural-game-assets/references/systems-inventory.md` |
| 17 | **Corpses are never retired, and ragdoll eviction orphans their meshes.** No `agents.splice` / `removeAgent` / `despawn` exists anywhere in `original/src`; the array is cleared only in `dispose()`. Dead agents keep their SkinnedMesh in the scene graph and are frustum-tested every frame forever. The only bound is `physics.maxRagdolls = 8` (`physics/index.js:197`) with FIFO eviction at `:811` — so after the 9th kill, corpse #1's ragdoll is disposed while its mesh remains | grep for the three retire spellings returns nothing; `maxRagdolls`/eviction read directly | n/a — **fixed in the fork already** by commit `05f8d0d` (corpse retirement + reinforcement waves), verified by `verify-lifecycle` 6/6 | — | OPEN in `original` only; fork is clear |
| 18 | A doc comment names a subsystem that does not exist: `ai/index.js:480` refers to "the behaviour tree". There is none — no blackboard, no node classes, no utility AI. It is a flat `switch` over 8 states (`agent.js:365`), which `agent.js:11` describes honestly | grep for behaviour/behavior tree + blackboard returns exactly one doc-comment hit | comment corrected | — | OPEN in `original` — cosmetic, **not scheduled** |

## OPEN — found 2026-07-26 auditing real gates with `prove-red` (outside this repo)

| # | What | Evidence | Closes when | Owner | State |
|---|---|---|---|---|---|
| 19 | **`premium-web-design` launches browsers unmuted in 35 files; ZERO pass `--mute-audio`.** This is the repo Matthew runs autonomously overnight ("build N sites, don't stop"), and it directly breaches the standing NOISE LAW that cost him ~40 min of untraceable audio on 2026-07-25 | `grep -rln 'chromium.launch\|puppeteer.launch\|launchPersistentContext' --include='*.mjs' --include='*.js'` → **35 files**; `grep -rn -- '--mute-audio'` → **0 hits** repo-wide | every browser launch in that repo passes `--mute-audio` | **Matthew to route** — repo is on branch `codex/harden-premium-web-design-workflow`, another lane's work; I did not edit it | **OPEN — highest priority of this batch** |
| 20 | **221 MB of `visual-craft` and all 4 working files of `verifier-integrity` are UNTRACKED in `~/.codex/skills` — they exist only on this Mac.** `verifier-integrity` has 1 tracked file (SKILL.md) and 4 untracked, including `scripts/checkpoint.mjs`, its runnable. `visual-craft` has 311 tracked vs **1,626 untracked** | `git cat-file -e origin/main:verifier-integrity/scripts/checkpoint.mjs` → **not on remote**; same for `visual-craft/tools` | both trees tracked and pushed, or an explicit written decision that they are intentionally local | **Matthew to route** — not my tree to commit | OPEN — data-loss exposure, no backup |
| 21 | **`premium-web-design/scripts/self_test.sh` is RED and takes ~356 s.** It is the *only* coverage for `ship-gate.mjs`, the 1,039-line script whose exit 0 defines DONE for client-facing web work | failing assertion confirmed present at `scripts/self_test.sh:1939` ("visual critic should score WebGL good fixture >=85 and credit verified motion-3d"). **Exit-1 status is single-source** — reported by an Opus-5 survey agent; I did not re-run it because doing so spawns unmuted browsers (row 19) | suite green, or the failing assertion retired with a reason | **Matthew to route** — another lane | OPEN |
| 22 | **The SHIP/NO-SHIP logic in `ship-gate.mjs` has no fast test.** A 0.17 s scoped check over its exported surface kills 10 of 60 sampled mutations; the other 50 are in the un-exported composition path that nothing fast reaches | `prove-red --check <scoped> --target scripts/ship-gate.mjs --max 60` → 10/60. Killed lines cluster exactly in `terminalAestheticPolicy` (:50), `assessEyesCapture` (:484, :499), `explicitByteBudgetPolicy` (:748) — the check reaches what it claims | a fast test exercises the composition path, or self_test.sh is fast and green enough to run per-change | **Matthew to route** | OPEN — **16.7% is a fact about the tests, NOT a quality verdict on the gate** |

---

## Method notes

- **The defining defect class is an integration gap**: subsystems individually correct, the seam
  between them unowned. The registry's own doc-block says the architecture exists so agents can
  "own files in isolation" — which is exactly what left the seams to nobody.
- **The verification loop had the same shape.** `ui.debugState('combat')` builds a scripted mock
  HUD the code labels *"for screenshots / critics"* — and `setBlips()`/`setObjectives()` are called
  **only** from it. The critic graded a HUD with enemy blips and objectives that no player ever saw.
- Every fix here connects existing correct code rather than writing new gameplay.
