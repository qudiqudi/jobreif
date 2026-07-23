"use strict";

// Funnel-Event "job-started" (anonyme Nutzungsstatistik) — Regression fuer die Kern-
// Zusicherung des PRs: der Beacon feuert GENAU EINMAL beim tatsaechlichen Loslegen
// (startReadyJob), nicht beim blossen Anzeigen der fertigen Karte (Polling/Resume/
// Re-Render) und nicht doppelt bei einem zweiten Klick. Testet die ECHTE Funktion:
// extrahiert sie per Klammer-Balance aus ../app.js und evaluiert sie in einem
// vm-Sandbox mit Spy-Stubs fuer ihre Abhaengigkeiten (kein Reimplementierungs-Drift,
// gleiches Muster wie sync-merge.test.js). Kein Netz, kein Browser.
// Start: node test/funnel-job-started.test.js

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

let failures = 0;
const assert = (cond, msg) => { if (cond) { console.log("  ok:", msg); } else { failures++; console.error("  FAIL:", msg); } };

// ===================== 1) Verhalten von startReadyJob (vm-Sandbox mit Spies) =====================
{
  const startReadyJobSrc = funcSrc("startReadyJob");

  function freshSandbox(job) {
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext([
      "var __calls = { trackEvent: [], clearActiveJob: 0, hideJobReadyBanner: 0, renderActiveJobCard: [], finalizeQuiz: [] };",
      "var __job = " + JSON.stringify(job) + ";",
      // Spy-Stubs im exakten Aufrufmuster von startReadyJob (kein DOM, kein Netz noetig).
      "function hideJobReadyBanner() { __calls.hideJobReadyBanner++; }",
      "function loadActiveJob() { return __job; }",
      // clearActiveJob leert den Zeiger wie im Original (localStorage-Aequivalent) —
      // ein zweiter startReadyJob()-Aufruf muss danach am Guard scheitern.
      "function clearActiveJob() { __calls.clearActiveJob++; __job = null; }",
      "function renderActiveJobCard(state) { __calls.renderActiveJobCard.push(state); }",
      "function finalizeQuiz(quiz, ctx) { __calls.finalizeQuiz.push({ quiz, ctx }); }",
      "function trackEvent(flow) { __calls.trackEvent.push(flow); }",
      startReadyJobSrc,
      "globalThis.__x = { startReadyJob, __calls };",
    ].join("\n"), sandbox);
    return sandbox.__x;
  }

  // 1a) Guard-Fall: kein aktiver Job → kein Beacon (keine Fehlzaehlung leerer Aufrufe)
  {
    const x = freshSandbox(null);
    x.startReadyJob();
    assert(x.__calls.trackEvent.length === 0, "kein Job: trackEvent NICHT aufgerufen");
    assert(x.__calls.hideJobReadyBanner === 1, "kein Job: hideJobReadyBanner trotzdem aufgerufen (P4-Hinweis raeumen)");
  }

  // 1b) Guard-Fall: Job ohne quiz (noch nicht fertig) → kein Beacon
  {
    const x = freshSandbox({ status: "pending" });
    x.startReadyJob();
    assert(x.__calls.trackEvent.length === 0, "Job ohne quiz: trackEvent NICHT aufgerufen");
  }

  // 1c) Tatsaechlicher Start: GENAU EIN Beacon mit Flow "job-started"
  {
    const x = freshSandbox({ quiz: { fragen: [] }, jobId: "j1", ctx: {} });
    x.startReadyJob();
    assert(x.__calls.trackEvent.length === 1, "echter Start: trackEvent genau einmal aufgerufen");
    assert(x.__calls.trackEvent[0] === "job-started", 'echter Start: Flow-Name exakt "job-started"');
    assert(x.__calls.clearActiveJob === 1, "echter Start: clearActiveJob genau einmal (Job wird konsumiert)");
    assert(x.__calls.finalizeQuiz.length === 1, "echter Start: finalizeQuiz genau einmal (Quiz wird tatsaechlich gestartet)");
  }

  // 1d) Kein Doppelfeuern bei einem zweiten Aufruf (z. B. Doppel-Klick): der Guard aus
  // 1a greift, weil clearActiveJob() den Zeiger nach dem ersten Start bereits geleert hat.
  {
    const x = freshSandbox({ quiz: { fragen: [] }, jobId: "j1", ctx: {} });
    x.startReadyJob();
    x.startReadyJob();
    assert(x.__calls.trackEvent.length === 1, "zweiter Aufruf direkt danach: weiterhin nur EIN Beacon insgesamt");
  }
}

// ===================== 2) Struktureller Beleg: nur EIN Vorkommen, nur im Start-Pfad =====================
// Beleg fuer "nicht beim blossen Anzeigen der fertigen Karte": trackEvent("job-started")
// darf im gesamten app.js nur ein einziges Mal vorkommen, und zwar innerhalb der
// Klammer-Grenzen von startReadyJob — NICHT in den reinen Anzeige-/Poll-Pfaden
// (renderActiveJobCard, pollActiveJob, resumeActiveJob, showJobReadyBanner), die die
// fertige Karte ohne einen tatsaechlichen Start rendern/aktualisieren koennen.
{
  const marker = 'trackEvent("job-started")';
  const hits = src.split(marker).length - 1;
  assert(hits === 1, `genau ein Vorkommen von ${marker} im Repo (gefunden: ${hits})`);

  const startBody = funcSrc("startReadyJob");
  assert(startBody.includes(marker), "das eine Vorkommen liegt innerhalb von startReadyJob");

  for (const name of ["renderActiveJobCard", "pollActiveJob", "resumeActiveJob", "showJobReadyBanner"]) {
    const body = funcSrc(name);
    assert(!body.includes(marker), `${name} (reine Anzeige/Poll) feuert KEINEN job-started-Beacon`);
  }
}

console.log(failures === 0 ? "\nAlle Checks bestanden." : `\n${failures} Check(s) fehlgeschlagen.`);
process.exit(failures === 0 ? 0 : 1);
