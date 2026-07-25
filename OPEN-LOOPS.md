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

---

## Method notes

- **The defining defect class is an integration gap**: subsystems individually correct, the seam
  between them unowned. The registry's own doc-block says the architecture exists so agents can
  "own files in isolation" — which is exactly what left the seams to nobody.
- **The verification loop had the same shape.** `ui.debugState('combat')` builds a scripted mock
  HUD the code labels *"for screenshots / critics"* — and `setBlips()`/`setObjectives()` are called
  **only** from it. The critic graded a HUD with enemy blips and objectives that no player ever saw.
- Every fix here connects existing correct code rather than writing new gameplay.
