#!/usr/bin/env node
/**
 * WIRING GATE — catches the defect class that dominates this codebase.
 *
 * Every core-loop bug found here was the same shape: a complete, correct,
 * fully-implemented producer or API with nothing on the other end.
 *
 *   player:death        emitted, zero subscribers        -> player never died
 *   player.respawn()    implemented, never called        -> no respawn
 *   ui.setMatch()       implemented, never called        -> clock frozen at 10:00
 *   ui.spawnGrenade()   implemented, never called        -> unsignalled grenades
 *   ui.setBlips()       called only from the demo mock   -> empty minimap
 *   audio.setMasterVolume() implemented, never called    -> no way to mute
 *
 * Each was found by hand, hours apart, and two were still missed on the first
 * pass. They are all mechanically detectable. This gate detects them.
 *
 * CHECK A — orphaned events.  The EventBus (core/registry.js) is an exact-key
 * Map with no wildcards, so "emitted but never subscribed" is decidable. The
 * reverse ("subscribed but never emitted") is reported too: it is dead handler
 * code or a typo'd name.
 *
 * CHECK B — advertised-but-uncalled API.  Modules document their public surface
 * in a doc-block header (`ui.setMatch({...})`). A documented method with no
 * callsite anywhere outside comments is either dead or an unwired seam.
 *
 * Usage:
 *   node tools/gate-wiring.mjs [--root <dir>] [--json] [--quiet]
 * Exit 0 = clean, 1 = findings. Baselines live in tools/gate-wiring.allow.json.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) return [a, true];
    return [m[1], m[2] ?? (arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true)];
  })
);

const ROOT = resolve(typeof args.root === 'string' ? args.root : join(import.meta.dirname, '..'));
const SCAN = ['src', 'tools'].map((d) => join(ROOT, d)).filter((d) => existsSync(d));

/* ------------------------------------------------------------------ files -- */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
}

const files = SCAN.flatMap((d) => walk(d));

/**
 * Strip block and line comments so a doc-block mention is never mistaken for a
 * real callsite. Deliberately crude — it does not need to survive strings
 * containing `//`, because a false *keep* only risks a missed finding, never a
 * false alarm, and CHECK B reports conservatively.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const CODE = new Map(); // path -> comment-stripped source
const RAW = new Map(); // path -> original source
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  RAW.set(f, s);
  CODE.set(f, stripComments(s));
}

const rel = (f) => relative(ROOT, f);
const allowPath = join(import.meta.dirname, 'gate-wiring.allow.json');
const allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : {};
const allowedEvents = new Set(allow.events ?? []);
const allowedMethods = new Set(allow.methods ?? []);

/* ------------------------------------------- CHECK A — orphaned events ---- */

const EV = "[\\w:.-]+";
const emitted = new Map(); // name -> [locations]
const subscribed = new Map();

const add = (map, name, loc) => {
  if (!map.has(name)) map.set(name, []);
  map.get(name).push(loc);
};

for (const f of files) {
  const code = CODE.get(f);
  const lines = code.split('\n');
  lines.forEach((line, i) => {
    const loc = `${rel(f)}:${i + 1}`;
    // emit('x') / emit("x") / emit(`x`)  — always via .emit(
    for (const m of line.matchAll(new RegExp(`\\.emit\\(\\s*['"\`](${EV})['"\`]`, 'g'))) {
      add(emitted, m[1], loc);
    }
    // Subscriptions come in two shapes in this codebase:
    //   ctx.events.on('x', fn)          direct
    //   on('x', fn)                     via a per-module local helper, e.g.
    //                                   const on = (t, fn) => ctx.events.on(t, fn)
    // Both count. `once` too.
    for (const m of line.matchAll(new RegExp(`\\.(?:on|once)\\(\\s*['"\`](${EV})['"\`]`, 'g'))) {
      add(subscribed, m[1], loc);
    }
    for (const m of line.matchAll(new RegExp(`(?:^|[^.\\w])(?:on|once)\\(\\s*['"\`](${EV})['"\`]`, 'g'))) {
      add(subscribed, m[1], loc);
    }
  });
}

// DOM/`window` events share the `.on(`/`addEventListener` vocabulary; only names
// containing a colon are engine events by this codebase's convention.
const isEngineEvent = (n) => n.includes(':');

const orphanEmits = [...emitted.keys()]
  .filter(isEngineEvent)
  .filter((n) => !subscribed.has(n))
  .filter((n) => !allowedEvents.has(n))
  .sort();

const deadSubs = [...subscribed.keys()]
  .filter(isEngineEvent)
  .filter((n) => !emitted.has(n))
  .filter((n) => !allowedEvents.has(n))
  .sort();

/* --------------------------------- CHECK B — advertised but uncalled ------ */

/**
 * Public API is documented in each module's header as `alias.method(...)`.
 * Collect those, then look for a real callsite `.method(` in stripped source.
 */
const advertised = new Map(); // method -> declaring file
for (const f of files) {
  const raw = RAW.get(f);
  for (const block of raw.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const text = block[0];
    if (!/PUBLIC API|Public API/.test(text)) continue;
    for (const m of text.matchAll(/^\s*\*\s+([a-zA-Z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\s*\(/gm)) {
      const method = m[2];
      if (!advertised.has(method)) advertised.set(method, rel(f));
    }
  }
}

const uncalled = [];
for (const [method, declaredIn] of advertised) {
  if (allowedMethods.has(method)) continue;
  // Must match every call form this codebase actually uses, including the
  // optional-call chain it leans on for duck-typed cross-subsystem calls:
  //   .m(   ?.m(   .m?.(   ?.m?.(
  // Missing the optional forms made this gate report setMatch() and
  // setControlEnabled() as uncalled when MatchSystem calls both — a false
  // positive in the checker, caught by running it against a known-good fix.
  const needle = new RegExp(`(?:\\?\\.|\\.)\\s*${method}\\s*(?:\\?\\.)?\\s*\\(`);
  let callers = 0;
  const where = [];
  for (const f of files) {
    if (!needle.test(CODE.get(f))) continue;
    // A definition is not a callsite; require a `.method(` form, which the
    // class body (`method(args) {`) does not produce.
    callers++;
    where.push(rel(f));
  }
  if (callers === 0) uncalled.push({ method, declaredIn });
  // Demo-only wiring is its own defect: implemented, but reachable only from the
  // screenshot mock the critic graded. Flag separately.
  else if (where.every((w) => /demo|preview|selftest|feeltest/.test(w))) {
    uncalled.push({ method, declaredIn, demoOnly: true, where });
  }
}
uncalled.sort((a, b) => a.method.localeCompare(b.method));

/* --------------------------------------------------------------- report --- */

const findings = orphanEmits.length + deadSubs.length + uncalled.length;

if (args.json) {
  console.log(JSON.stringify({ root: rel(ROOT) || '.', orphanEmits, deadSubs, uncalled, findings }, null, 2));
} else if (!args.quiet) {
  const B = (s) => `\n${s}\n${'-'.repeat(s.length)}`;
  console.log(`WIRING GATE — ${files.length} files under ${ROOT}`);

  console.log(B('A1. Events EMITTED but never SUBSCRIBED'));
  if (!orphanEmits.length) console.log('  none');
  for (const n of orphanEmits) console.log(`  ${n}\n      emitted at ${emitted.get(n).join(', ')}`);

  console.log(B('A2. Events SUBSCRIBED but never EMITTED (dead handlers / typos)'));
  if (!deadSubs.length) console.log('  none');
  for (const n of deadSubs) console.log(`  ${n}\n      handled at ${subscribed.get(n).join(', ')}`);

  console.log(B('B. Public API advertised in a doc-block with no real callsite'));
  if (!uncalled.length) console.log('  none');
  for (const u of uncalled) {
    console.log(
      u.demoOnly
        ? `  ${u.method}()  [DEMO-ONLY] declared ${u.declaredIn} — reachable only from ${u.where.join(', ')}`
        : `  ${u.method}()  declared ${u.declaredIn} — no callsite anywhere`
    );
  }

  console.log(`\n===== ${findings} finding(s) =====`);
}

process.exit(findings ? 1 : 0);
