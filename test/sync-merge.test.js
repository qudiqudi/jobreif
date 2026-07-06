"use strict";

// Merge-Kern-Regression (Geraete-Sync F3): der subtilste Client-Code (mergeHistory/mergeTwoJobs/
// pickDesc/dedupeAttempts) — Konflikt-Matrix (Plan Sec 5) + die Lattice-Eigenschaften
// (kommutativ/idempotent/assoziativ/Absorption/kein Datenverlust), die zwei Fix-PRs gebraucht
// haben. Testet die ECHTEN Funktionen: extrahiert sie per Klammer-Balance aus ../app.js und
// evaluiert sie in einem vm-Sandbox (kein Reimplementierungs-Drift). Kein Netz, kein Browser.
// Start: node test/sync-merge.test.js

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// --- exakte Quelltexte der reinen Funktionen/Konstanten aus app.js ziehen ---
function funcSrc(name) {
  const m = src.search(new RegExp("function " + name + "\\b"));
  if (m < 0) throw new Error("nicht gefunden: function " + name);
  let i = src.indexOf("{", m), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { if (--depth === 0) return src.slice(m, i + 1); } }
  throw new Error("keine Klammer-Balance: " + name);
}
function constLine(name) {
  const m = src.search(new RegExp("const " + name + "\\b"));
  if (m < 0) throw new Error("nicht gefunden: const " + name);
  return src.slice(m, src.indexOf("\n", m));
}
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  constLine("HISTORY_MAX_JOBS"), constLine("HISTORY_MAX_ATTEMPTS"),
  constLine("cmpStr"), funcSrc("canonKeys"), funcSrc("hashStr"), funcSrc("identityKeyOf"),
  funcSrc("jobRecency"), funcSrc("dedupeAttempts"), funcSrc("dedupeTombstones"),
  constLine("HANDLED_JOB_FIELDS"), constLine("cockKey"), constLine("pickDesc"),
  funcSrc("mergeTwoJobs"), funcSrc("mergeHistory"),
  "globalThis.__x = { mergeTwoJobs, mergeHistory, canonKeys, HISTORY_MAX_JOBS };",
].join("\n"), sandbox);
const { mergeTwoJobs, mergeHistory, canonKeys, HISTORY_MAX_JOBS } = sandbox.__x;
const canon = (x) => JSON.stringify(canonKeys(x));

let failures = 0;
const assert = (cond, msg) => { if (cond) { console.log("  ok:", msg); } else { failures++; console.error("  FAIL:", msg); } };

// ===================== 1) Konflikt-Matrix (deterministische Szenarien) =====================
const job = (key, attempts, extra = {}) => ({ key, attempts, ...extra });
const at = (id, date, extra = {}) => ({ id, date, ...extra });
const H = (jobs, deleted = []) => ({ jobs, deleted });
const attemptIds = (h, key) => { const j = h.jobs.find((x) => x.key === key); return j ? j.attempts.map((a) => a.id).sort() : null; };

// 1a) Union der Versuche
{
  const m = mergeHistory(H([job("X", [at("a1", 1000), at("a2", 2000)])]), H([job("X", [at("a1", 1000), at("a3", 3000)])]));
  assert(JSON.stringify(attemptIds(m, "X")) === JSON.stringify(["a1", "a2", "a3"]), "Union: a1+a2+a3, kein Versuch verloren");
}
// 1b) Tombstone entfernt aeltere Versuche; Job verschwindet
{
  const m = mergeHistory(H([job("X", [at("a1", 1000)])]), H([], [{ jobKey: "X", ts: 5000 }]));
  assert(!m.jobs.some((j) => j.key === "X"), "Tombstone: geloeschter Job X weg (Versuch aelter als ts)");
}
// 1c) Tombstone vs. NEUERER Versuch: neuerer ueberlebt
{
  const m = mergeHistory(H([job("Z", [at("z1", 1000), at("z2", 9000)])]), H([], [{ jobKey: "Z", ts: 5000 }]));
  assert(JSON.stringify(attemptIds(m, "Z")) === JSON.stringify(["z2"]), "Tombstone vs. neuer: nur z2 (date > ts) ueberlebt");
}
// 1d) Edit/Restore-beats-Delete: updatedAt > ts hebt den Tombstone auf
{
  const m = mergeHistory(H([job("R", [at("r1", 1000)], { updatedAt: 6000 })]), H([], [{ jobKey: "R", ts: 5000 }]));
  assert(JSON.stringify(attemptIds(m, "R")) === JSON.stringify(["r1"]), "Restore-beats-Delete: updatedAt>ts erhaelt den Job");
}
// 1e) Caps NACH dem Merge: >20 Jobs → 20, aelteste raus, deterministisch
{
  const jobs = [];
  for (let i = 0; i < 25; i++) jobs.push(job("J" + i, [at("x" + i, 1000 + i)]));
  const m = mergeHistory(H(jobs), H([]));
  assert(m.jobs.length === HISTORY_MAX_JOBS, "Caps: 25 Jobs → 20");
  assert(m.jobs.every((j) => Number(j.key.slice(1)) >= 5), "Caps: J0–J4 (aelteste) raus");
}
// 1f) Metadaten: Cockpit-Edit (updatedAt) propagiert; bloszer Versuch kippt ihn NICHT
{
  const A = H([job("X", [at("a1", 1000)], { gespraechAm: 7000000, updatedAt: 500 })]);
  const B = H([job("X", [at("a1", 1000), at("a2", 2000)])]); // neuer Versuch, KEIN Cockpit-Edit, kein updatedAt
  const m = mergeHistory(A, B);
  const jx = m.jobs.find((j) => j.key === "X");
  assert(jx && jx.attempts.length === 2, "Metadaten: B's Versuch a2 ueberlebt (Union)");
  assert(jx && jx.gespraechAm === 7000000, "Metadaten: A's Termin ueberlebt B's bloszen Versuch (kein Wholesale-Revert)");
}
// 1g) Geloeschtes Cockpit-Feld bleibt geloescht (kein Feld-Union-Resurrect)
{
  const withDate = job("X", [at("a1", 1000)], { gespraechAm: 111, updatedAt: 100 });
  const cleared = job("X", [at("a1", 1000)], { updatedAt: 200 }); // spaeter, Termin entfernt
  const m = mergeHistory(H([withDate]), H([cleared]));
  const jx = m.jobs.find((j) => j.key === "X");
  assert(jx && jx.gespraechAm === undefined, "Cockpit-Loeschung (hoeheres updatedAt) bleibt geloescht");
}

// ===================== 2) Lattice-Eigenschaften von mergeTwoJobs (Mini-Fuzz) =====================
let seed = 20260706;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const POOL = {}; for (const id of ["p1", "p2", "p3"]) POOL[id] = { id, date: pick([1000, 2000]), prozent: pick([40, 60, 80]) };
function randJob() {
  const j = { key: "K" };
  if (rnd() < 0.85) j.titel = pick(["T0", "T1", "", "T2"]);
  if (rnd() < 0.5) j.arbeitgeber = pick(["AG0", "AG1"]);
  if (rnd() < 0.5) j.urlKey = pick(["u0", "u1"]);
  const n = Math.floor(rnd() * 3), a = [];
  for (let i = 0; i < n; i++) a.push(POOL[pick(["p1", "p2", "p3"])]);
  j.attempts = a;
  if (rnd() < 0.5) j.updatedAt = pick([0, 5, 5, 10]);
  if (rnd() < 0.5) j.status = pick(["beworben", "absage"]);
  if (rnd() < 0.5) j.gespraechAm = pick([111, 222]);
  if (rnd() < 0.4) j.themenfelder = { v: 1, generatedAt: pick([100, 100, 200]), fields: [pick(["F0", "F1"])] };
  return j;
}
const descKeys = (j) => Object.keys(j).filter((k) => !["attempts", "themenfelder", "status", "gespraechAm", "updatedAt", "key"].includes(k) && j[k] !== undefined);
let comm = 0, idem = 0, assoc = 0, absorb = 0, loss = 0, keyord = 0;
const N = 60000;
for (let t = 0; t < N; t++) {
  const a = randJob(), b = randJob(), c = randJob();
  const ab = mergeTwoJobs(a, b), ba = mergeTwoJobs(b, a);
  if (canon(ab) !== canon(ba)) comm++;
  if (JSON.stringify(ab) !== JSON.stringify(ba)) keyord++;
  if (canon(mergeTwoJobs(a, mergeTwoJobs(b, c))) !== canon(mergeTwoJobs(mergeTwoJobs(a, b), c))) assoc++;
  if (canon(mergeTwoJobs(b, ab)) !== canon(ab)) absorb++;
  for (const k of new Set([...descKeys(a), ...descKeys(b)])) if (ab[k] === undefined) loss++;
  if (canon(mergeTwoJobs(ab, ab)) !== canon(ab)) idem++;
}
assert(comm === 0, `kommutativ (${comm}/${N} Verletzungen)`);
assert(idem === 0, `idempotent (${idem})`);
assert(assoc === 0, `assoziativ (${assoc})`);
assert(absorb === 0, `Absorption (${absorb})`);
assert(loss === 0, `kein Datenverlust deskriptiver Felder (${loss})`);
assert(keyord === 0, `deterministische Feldreihenfolge (${keyord})`);

// --- Kind `devices`: ts-LWW + gone-Marker (Fable-Review-Findings der Geräteliste) ---
// Die Konflikt-Uhr MUSS das ms-ts sein, nicht der tagesgrobe lastSeen — sonst gewinnt der
// morgendliche Aktiv-Stempel gegen ein Abkoppeln am selben Tag und der gone-Marker
// propagiert nie. Diese Tests verankern genau das.
{
  const devSandbox = {};
  vm.createContext(devSandbox);
  vm.runInContext([
    constLine("cmpStr"), funcSrc("dateInputToTs"),
    funcSrc("sanitizeDeviceEntry"), funcSrc("mergeDevices"),
    "globalThis.__d = { mergeDevices, sanitizeDeviceEntry };",
  ].join("\n"), devSandbox);
  const { mergeDevices, sanitizeDeviceEntry } = devSandbox.__d;
  const dj = (x) => JSON.stringify(x);
  const A = "aaaaaaaaaaaaaaaa", B = "bbbbbbbbbbbbbbbb";

  // gone (spaeteres Ereignis am selben Tag) schlaegt aktiv — in beide Merge-Richtungen
  const act = { devices: { [A]: { label: "Linux · Chrome", lastSeen: "2026-07-06", ts: 1000 } } };
  const gone = { devices: { [A]: { label: "Linux · Chrome", lastSeen: "2026-07-06", ts: 2000, gone: true } } };
  assert(mergeDevices(act, gone).devices[A].gone === true, "devices: gone-Marker gewinnt per ts (a,b)");
  assert(mergeDevices(gone, act).devices[A].gone === true, "devices: gone-Marker gewinnt per ts (b,a)");
  // Re-Aktivieren (noch spaeteres Ereignis) gewinnt wieder
  const reAct = { devices: { [A]: { label: "Linux · Chrome", lastSeen: "2026-07-06", ts: 3000 } } };
  assert(!mergeDevices(gone, reAct).devices[A].gone, "devices: Re-Aktivieren schlaegt gone");
  // exakter ts-Gleichstand: gone gewinnt (deterministisch, bewusstere Aussage)
  const actSame = { devices: { [A]: { label: "Linux · Chrome", lastSeen: "2026-07-06", ts: 2000 } } };
  assert(mergeDevices(actSame, gone).devices[A].gone === true, "devices: ts-Tie → gone");
  assert(dj(mergeDevices(actSame, gone)) === dj(mergeDevices(gone, actSame)), "devices: Tie kommutativ");
  // Union + Sanitizing: invalide Id/ungueltiges Datum fliegen, fehlendes ts wird aus lastSeen abgeleitet
  const u = mergeDevices(
    { devices: { [A]: { label: "X", lastSeen: "2026-07-01" } } },
    { devices: { [B]: { label: "Y", lastSeen: "2026-07-02", ts: 5 }, "BAD!": { label: "Z", lastSeen: "2026-07-02" }, cccccccccccccccc: { label: "W", lastSeen: "2026-99-99" } } }
  );
  assert(Object.keys(u.devices).sort().join(",") === [A, B].join(","), "devices: Union + Verwerfen invalider Eintraege");
  assert(typeof u.devices[A].ts === "number" && u.devices[A].ts > 0, "devices: ts-Fallback aus lastSeen");
  assert(sanitizeDeviceEntry({ label: "L", lastSeen: "2026-99-99" }) === null, "devices: unmoegliches Datum abgewiesen");
  // Lattice-Eigenschaften (Zufall)
  const rndDev = (rnd) => {
    const ids = [A, B, "cccccccccccccccc"], out = {};
    for (const id of ids) if (rnd() < 0.7) out[id] = {
      label: rnd() < 0.5 ? "L1" : "L2",
      lastSeen: rnd() < 0.5 ? "2026-07-05" : "2026-07-06",
      ts: Math.floor(rnd() * 5) * 1000,
      ...(rnd() < 0.3 ? { gone: true } : {}),
    };
    return { devices: out };
  };
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let dcomm = 0, didem = 0, dassoc = 0;
  for (let t = 0; t < 20000; t++) {
    const a = rndDev(rnd), b = rndDev(rnd), c = rndDev(rnd);
    const ab = mergeDevices(a, b);
    if (dj(ab) !== dj(mergeDevices(b, a))) dcomm++;
    if (dj(mergeDevices(ab, ab)) !== dj(ab)) didem++;
    if (dj(mergeDevices(a, mergeDevices(b, c))) !== dj(mergeDevices(ab, c))) dassoc++;
  }
  assert(dcomm === 0, `devices: kommutativ (${dcomm})`);
  assert(didem === 0, `devices: idempotent (${didem})`);
  assert(dassoc === 0, `devices: assoziativ (${dassoc})`);
}

if (failures) { console.error(`\n${failures} FEHLER`); process.exit(1); }
console.log("\nsync-merge.test.js OK");
