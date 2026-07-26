/**
 * Match state — the round clock, the two team scores, and the death/respawn cycle.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every piece of machinery this subsystem drives was already written, correct, and
 * unreachable. `player/health.js` emitted `player:death` to nobody. `player.respawn()`
 * was fully implemented and never called. `ui.setMatch()` was implemented and never
 * called, so `timeLeft` sat at its initial 600 and the HUD clock read a frozen 10:00
 * for the entire session. `scoreThem` had a render path and no increment path.
 *
 * The consequence was a game with no lose condition: the player dropped to 0 HP and
 * kept playing. `Health.damage()` returns 0 once `dead` is set, and `Health.heal()`
 * is gated on `!dead`, so from that moment the player was permanently invulnerable,
 * permanently un-healable, and permanently wearing the low-health desaturation grade.
 *
 * Nothing here re-implements gameplay. It owns the seam between subsystems that each
 * work in isolation — which is precisely the seam a fan-out build leaves unowned.
 */

const MATCH = {
  /** Round length in seconds. Matches the 600 the HUD was already initialised to. */
  duration: 600,
  /** Seconds between death and respawn — CoD sits around 3s for TDM. */
  respawnDelay: 3.0,
  /** Score needed to end the round early. 0 disables. */
  scoreLimit: 75,
};

/** Enough to fully restore from any state; heal() clamps to max. */
const HEALTH_FULL = 1000;

export class MatchSystem {
  static id = 'match';
  /** ui for the HUD contract, player for respawn. Both are hard requirements. */
  static deps = ['ui', 'player'];

  async init(ctx) {
    this.ctx = ctx;
    this._unsubs = [];

    this.timeLeft = MATCH.duration;
    this.scoreThem = 0;
    this.over = false;

    /** Set while the player is dead and waiting on the respawn timer. */
    this.awaitingRespawn = false;
    this.respawnIn = 0;
    this._deaths = 0;

    this._unsubs.push(ctx.events.on('player:death', () => this._onPlayerDeath()));

    // Push the opening state once so the HUD starts from a real value rather than
    // whatever the UI happened to initialise itself to.
    this._publish();
  }

  /* ------------------------------------------------------------------ death -- */

  _onPlayerDeath() {
    // `player:death` fires from inside Health.damage(). Guard re-entry: a burst can
    // land several rounds in one frame, and only the first should count as a death.
    if (this.awaitingRespawn) return;

    // Round already over. Do NOT start a respawn cycle — but never leave the
    // player as a 0-HP corpse either. Returning bare here produced a permanent
    // invulnerable-but-controllable body: damage() returns 0 while dead and
    // nothing else in the build calls heal(), so the state was terminal.
    // heal() clears the dead flag as of the 1.3b fix, so this is a full recovery.
    if (this.over) {
      this.ctx.peek('player')?.health?.heal?.(HEALTH_FULL);
      return;
    }

    this.awaitingRespawn = true;
    this.respawnIn = MATCH.respawnDelay;
    this._deaths++;
    this.scoreThem++;

    const ui = this.ctx.peek('ui');
    ui?.banner?.show?.('You Were Killed', `Respawning in ${MATCH.respawnDelay.toFixed(0)}s`);

    // Take control away while dead. Without this the corpse-camera is still fully
    // drivable, which is what made the original build read as "invulnerable" rather
    // than "dead" — the player never lost agency, so nothing signalled a death.
    this.ctx.peek('player')?.setControlEnabled?.(false);

    this._publish();
    if (MATCH.scoreLimit && this.scoreThem >= MATCH.scoreLimit) this._end('score');
  }

  _respawn() {
    this.awaitingRespawn = false;

    const player = this.ctx.peek('player');
    if (!player) return;

    // Rotate spawn points so repeated deaths do not drop the player back into the
    // same firefight. `world.spawn()` already wraps modulo its point count.
    player.respawn(this._deaths);
    player.setControlEnabled?.(true);

    // No `player:respawn` emit here on purpose. Nothing consumes it, and an
    // event with no subscriber is the exact defect class this fork exists to
    // remove — tools/gate-wiring.mjs flags it. Re-add it the moment a real
    // consumer exists (audio respawn cue, analytics), not before.
    this._publish();
  }

  /* ------------------------------------------------------------------ frame -- */

  update(dt) {
    // The respawn countdown services FIRST, and unconditionally.
    //
    // This used to sit below an `if (this.over) return;`, which made _end('time')
    // the last frame that ever decremented respawnIn. Dying as the clock ran out
    // therefore froze the player permanently: 0 HP, control disabled, respawnIn
    // stuck mid-count, no restart in the pause menu, and the only exit a page
    // reload. Measured: respawnIn frozen at 1.483 for 58s of game time with W held
    // and zero movement.
    if (this.awaitingRespawn) {
      this.respawnIn -= dt;
      if (this.respawnIn <= 0) this._respawn();
    }

    if (this.over) return;

    const before = this.timeLeft;
    this.timeLeft = Math.max(0, this.timeLeft - dt);

    // The HUD clock only renders to whole seconds, so only push when one ticks over.
    // setMatch() is a plain Object.assign into UI state; calling it every frame would
    // be harmless but pointless.
    if ((before | 0) !== (this.timeLeft | 0) || this.awaitingRespawn) this._publish();

    if (this.timeLeft <= 0) this._end('time');
  }

  _publish() {
    // Only the fields this subsystem owns. `scoreUs` is incremented by the UI itself
    // on `damage:dealt` with `killed`, and must not be clobbered from here.
    this.ctx.peek('ui')?.setMatch?.({
      timeLeft: this.timeLeft,
      scoreThem: this.scoreThem,
      mode: 'TDM',
    });
  }

  _end(reason) {
    if (this.over) return;
    this.over = true;
    const ui = this.ctx.peek('ui');
    const scoreUs = ui?.state?.scoreUs ?? 0;
    const won = scoreUs > this.scoreThem;
    ui?.banner?.show?.(won ? 'Victory' : 'Defeat', `${scoreUs} — ${this.scoreThem}`, 8);

    // Never end a round with the player mid-death. If a respawn was pending, run
    // it now rather than stranding them; otherwise just make sure control is back.
    // Without this, the round-end banner could appear over a frozen corpse.
    const player = this.ctx.peek('player');
    if (this.awaitingRespawn) this._respawn();
    else player?.setControlEnabled?.(true);
    // Same reasoning as the respawn emit: the banner above IS the consumer. A
    // `match:end` broadcast with no subscriber would just be another orphan.
    // Read `match.over` / `match.scoreThem` directly if you need round state.
  }

  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
  }
}
