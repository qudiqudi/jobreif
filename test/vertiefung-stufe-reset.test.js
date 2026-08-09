"use strict";

// Gespraechsstufe im geteilten <select>: Regression fuer den Config-Bleed in die
// Vertiefung. Das Formular hat genau EIN <select id="gespraechsstufe">; generateQuiz
// liest es live. startTestForJob setzt es deshalb immer aus der Konfig der Stelle —
// startVertiefungForJob muss dasselbe tun, sonst laeuft ein bezahlter Vertiefungsbogen
// (und spaeter dessen Auswertung) mit der Stufe einer ANDEREN Stelle bzw. mit einem in
// der Eingabemaske stehen gebliebenen Wert. Testet die ECHTE Funktion: extrahiert sie
// per Klammer-Balance aus ../app.js und evaluiert sie in einer vm-Sandbox mit
// Stub-Abhaengigkeiten (gleiches Muster wie funnel-job-started.test.js). Kein Netz,
// kein Browser.
// Start: node test/vertiefung-stufe-reset.test.js

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// --- exakten Quelltext einer Funktion per Klammer-Balance aus app.js ziehen ---
function funcSrc(name) {
  const m = src.search(new RegExp("function " + name + "\\b"));
  if (m < 0) throw new Error("nicht gefunden: function " + name);
  let i = src.indexOf("{", m), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { if (--depth === 0) return src.slice(m, i + 1); } }
  throw new Error("keine Klammer-Balance: " + name);
}

// --- Block ab einem Marker (z. B. ein addEventListener-Handler) per Klammer-Balance ---
function blockSrc(marker) {
  const m = src.indexOf(marker);
  if (m < 0) throw new Error("nicht gefunden: " + marker);
  let i = src.indexOf("{", m), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { if (--depth === 0) return src.slice(m, i + 1); } }
  throw new Error("keine Klammer-Balance: " + marker);
}

let failures = 0;
const assert = (cond, msg) => { if (cond) { console.log("  ok:", msg); } else { failures++; console.error("  FAIL:", msg); } };

// ===================== 1) startVertiefungForJob setzt das geteilte Select =====================
{
  const GESPRAECHSSTUFEN_SRC = src.match(/^const GESPRAECHSSTUFEN = .*$/m)[0];

  // Sandbox mit genau den Abhaengigkeiten, die startVertiefungForJob aufruft.
  // Gestubbt sind nur die Randbedingungen (DOM, Speichern, Generierung); die
  // Stufen-Logik selbst kommt unveraendert aus app.js (normalizeTestConfig/clampNum).
  function freshSandbox(leakedStufe) {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext([
      "var __calls = { generateQuiz: [], saveDraft: 0 };",
      "var actionRunning = false;",
      "var lastFetch = { url: '', text: '' };",
      "var __els = {",
      "  'job-text': { value: '' },",
      "  'job-url': { value: '' },",
      "  'num-questions': { value: '' },",
      "  'gespraechsstufe': { value: " + JSON.stringify(leakedStufe) + " },",
      "};",
      "function $(id) { return __els[id] || null; }",
      "var document = { querySelector() { return { checked: false }; } };",
      "function setSourceTab() {}",
      "function saveDraft() { __calls.saveDraft++; }",
      "function computeJobProgress() { return { level: 3, bestPct: 70 }; }",
      "function generateQuiz(opts) { __calls.generateQuiz.push(opts); }",
      // Grenzen des Fragen-Steppers stubben, damit clampNum ohne settings/Tier-Zustand laeuft.
      "var NUM_MIN = 4;",
      "function numMax() { return 20; }",
      GESPRAECHSSTUFEN_SRC,
      funcSrc("clampNum"),
      funcSrc("normalizeTestConfig"),
      funcSrc("startVertiefungForJob"),
      "globalThis.__x = { startVertiefungForJob, __els, __calls };",
    ].join("\n"), sandbox);
    return sandbox.__x;
  }

  const felder = [{ id: "f1", label: "Feld 1" }];

  // 1a) Kernfall: in der Maske/von einer anderen Stelle stehen gebliebene Stufe, die
  // Stelle selbst hat keine gemerkte Stufe -> Vertiefung laeuft "Allgemein", nicht Assessment.
  {
    const x = freshSandbox("assessment");
    x.startVertiefungForJob({ jobText: "T", lastTestConfig: { mode: "lernen", difficulty: "mittel", num: 10, stufe: "" } }, "pruefung", 8, felder);
    assert(x.__els["gespraechsstufe"].value === "", "Fremdwert 'assessment' wird auf '' (Allgemein) zurueckgesetzt");
    assert(x.__calls.generateQuiz.length === 1, "Vertiefung wird trotzdem normal gestartet (generateQuiz einmal)");
  }

  // 1b) Die pro Stelle gemerkte Stufe gewinnt (konsistent zu den Chips im Start-Panel).
  {
    const x = freshSandbox("assessment");
    x.startVertiefungForJob({ jobText: "T", lastTestConfig: { mode: "lernen", difficulty: "mittel", num: 10, stufe: "telefon" } }, "lernen", 8, felder);
    assert(x.__els["gespraechsstufe"].value === "telefon", "gemerkte Stufe der Stelle ('telefon') wird uebernommen");
  }

  // 1c) Alte Stelle ohne lastTestConfig: defensiv "" statt Fremdwert.
  {
    const x = freshSandbox("telefon");
    x.startVertiefungForJob({ jobText: "T" }, "lernen", 8, felder);
    assert(x.__els["gespraechsstufe"].value === "", "Stelle ohne lastTestConfig -> '' statt Fremdwert");
  }

  // 1d) Nicht mehr angebotener gespeicherter Wert ("leitung") faellt auf "" zurueck.
  {
    const x = freshSandbox("assessment");
    x.startVertiefungForJob({ jobText: "T", lastTestConfig: { stufe: "leitung" } }, "lernen", 8, felder);
    assert(x.__els["gespraechsstufe"].value === "", "ungueltige gemerkte Stufe ('leitung') -> ''");
  }
}

// ===================== 2) "Neue Stelle" ist ein echter Frischstart =====================
// Der Reset leert Link und Text; die geteilte Gespraechsstufe muss ebenso zurueck auf
// "Allgemein", sonst ist sie in der frischen Maske still vorausgewaehlt.
{
  const handler = blockSrc('$("btn-new-job").addEventListener("click"');
  assert(/gespraechsstufe/.test(handler), 'btn-new-job-Reset fasst das gespraechsstufe-Select an');
  assert(/\.value = "";/.test(handler.slice(handler.indexOf("gespraechsstufe"))), "btn-new-job-Reset setzt die Stufe auf \"\" (Allgemein)");
  assert(handler.indexOf("gespraechsstufe") < handler.indexOf('showView("view-input")'), "Reset passiert VOR showView (Kontext-Hinweis wird neu berechnet)");
}

console.log(failures === 0 ? "\nAlle Checks bestanden." : `\n${failures} Check(s) fehlgeschlagen.`);
process.exit(failures === 0 ? 0 : 1);
