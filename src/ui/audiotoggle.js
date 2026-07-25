/**
 * Audio mute toggle — button + M key.
 *
 * WHY THIS EXISTS
 * ---------------
 * The build shipped with no way to silence itself. `audio.setMasterVolume()` and
 * `audio.setBusVolume()` existed and were correct; the settings menu had quality,
 * sensitivity and FOV controls and no audio section at all, so nothing ever called
 * them. Same shape as the rest of this codebase's defects: a working API with no
 * caller. A player whose only exit is closing the tab does not have a mute control.
 *
 * The button lives OUTSIDE `.ow-hud` on purpose. The HUD is `pointer-events:none`
 * and fades to 15% opacity behind the menu, neither of which is acceptable for the
 * one control you reach for when you want the noise to stop.
 *
 * Pointer lock hides the cursor during play, so the KEY is the primary path and the
 * button is for when the cursor is free (menu open, or before first click). Both
 * route through the same toggle.
 */

const KEY = 'ow.audio.muted';
/** Mixer default (see audio/mixer.js `masterVolume`). Restored verbatim on unmute. */
const UNMUTED_VOLUME = 0.95;
const CSS = `
.ow-mute{
  position:fixed; left:24px; bottom:13vh; z-index:40;
  display:flex; align-items:center; gap:8px;
  padding:7px 12px 7px 10px;
  font:600 12px/1 ui-sans-serif,system-ui,"Helvetica Neue",Arial,sans-serif;
  letter-spacing:.14em; text-transform:uppercase;
  color:rgba(255,255,255,.86);
  background:rgba(8,10,14,.62); border:1px solid rgba(255,255,255,.16);
  border-radius:4px; cursor:pointer; user-select:none;
  backdrop-filter:blur(6px);
  text-shadow:0 1px 2px rgba(0,0,0,.9);
  transition:background .12s ease, border-color .12s ease, color .12s ease;
}
.ow-mute:hover{ background:rgba(18,22,30,.86); border-color:rgba(255,255,255,.34); }
.ow-mute .ow-mute-ico{ width:15px; height:15px; flex:0 0 15px; display:block; }
.ow-mute .ow-mute-key{
  font-size:10px; padding:2px 5px; border-radius:3px;
  color:rgba(255,255,255,.62); background:rgba(255,255,255,.10);
}
.ow-mute[data-muted="1"]{
  color:#ff6b5e; border-color:rgba(255,107,94,.55); background:rgba(40,10,10,.66);
}
`;

const ICON_ON = `<svg class="ow-mute-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;
const ICON_OFF = `<svg class="ow-mute-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6"/><path d="m17 9 6 6"/></svg>`;

export class AudioToggle {
  constructor(ctx, host) {
    this.ctx = ctx;

    if (!document.getElementById('ow-mute-style')) {
      const s = document.createElement('style');
      s.id = 'ow-mute-style';
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    let saved = false;
    try {
      saved = localStorage.getItem(KEY) === '1';
    } catch {
      /* private mode / storage disabled — default to unmuted */
    }
    this.muted = saved;

    this.root = document.createElement('button');
    this.root.type = 'button';
    this.root.className = 'ow-mute';
    this.root.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
      // Do not keep focus: a focused button eats the next Space as a re-click,
      // and Space is jump.
      this.root.blur();
    });
    (host ?? document.body).appendChild(this.root);

    this._onKey = (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code !== 'KeyM') return;
      const t = e.target;
      // Never steal the key from a text field (the settings menu has inputs).
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      this.toggle();
    };
    window.addEventListener('keydown', this._onKey);

    this._paint();
    // Apply the persisted state once audio exists. init order is not guaranteed
    // and the graph itself only starts on a user gesture, so re-assert on a short
    // delay rather than assuming the subsystem is up.
    this._apply();
    this._retry = setTimeout(() => this._apply(), 1200);

    console.info(`[audio] mute toggle ready — press M (or click the button). muted=${this.muted}`);
  }

  toggle() {
    this.setMuted(!this.muted);
  }

  setMuted(v) {
    this.muted = !!v;
    try {
      localStorage.setItem(KEY, this.muted ? '1' : '0');
    } catch {
      /* non-fatal */
    }
    this._paint();
    this._apply();
    this.ctx?.events?.emit?.('ui:mute', { muted: this.muted });
  }

  /**
   * Master volume is the single choke point for every bus, so muting here also
   * silences ambience, weapons, foley and voice without touching their mixes —
   * unmuting restores the original balance exactly.
   */
  _apply() {
    const audio = this.ctx?.peek?.('audio');
    audio?.setMasterVolume?.(this.muted ? 0 : UNMUTED_VOLUME);
  }

  /**
   * Re-assert the mute if the mixer has drifted from it.
   *
   * The Web Audio graph does not exist until a user gesture, and it builds itself
   * at the mixer's own default gain. A mute chosen before that moment — from
   * localStorage on boot, or by pressing M on the title screen — was therefore
   * silently discarded the instant the graph came up, and the noise started
   * anyway. Measured: masterVolume read `null`, then `0.95`, while the button
   * still said MUTED.
   *
   * Called once per frame from UiSystem.lateUpdate. It is two property reads and
   * a compare in the common case, and it makes the control immune to init order.
   */
  sync() {
    const mixer = this.ctx?.peek?.('audio')?.mixer;
    if (!mixer) return;
    const want = this.muted ? 0 : UNMUTED_VOLUME;
    if (Math.abs((mixer.masterVolume ?? want) - want) > 1e-3) this._apply();
  }

  _paint() {
    this.root.dataset.muted = this.muted ? '1' : '0';
    this.root.setAttribute('aria-pressed', this.muted ? 'true' : 'false');
    this.root.setAttribute('aria-label', this.muted ? 'Unmute audio' : 'Mute audio');
    this.root.innerHTML =
      (this.muted ? ICON_OFF : ICON_ON) +
      `<span>${this.muted ? 'Muted' : 'Audio'}</span><span class="ow-mute-key">M</span>`;
  }

  dispose() {
    clearTimeout(this._retry);
    window.removeEventListener('keydown', this._onKey);
    this.root?.remove();
    document.getElementById('ow-mute-style')?.remove();
  }
}
