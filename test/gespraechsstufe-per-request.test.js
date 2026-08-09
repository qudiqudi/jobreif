"use strict";

// Gespraechsstufe pro Anfrage: generateQuiz muss die Stufe beim AUSLOESEN festhalten, nicht
// erst beim Absenden aus dem geteilten <select id="gespraechsstufe"> lesen.
//
// Warum das zaehlt: zwischen Klick und Payload liegen await-Punkte (Ersetzen-Rueckfrage,
// Guthaben-Aktualisierung), und actionRunning ist in diesem Fenster noch NICHT gesetzt. Eine
// andere Start- oder Navigations-Aktion kann das Select genau dann umsetzen — der
// kostenpflichtige Lauf bekaeme sonst die Stufe einer anderen Stelle, und ueber
// quiz.gespraechsstufe auch dessen Auswertung und die gemerkte Konfig der Stelle.
//
// Der bestehende Test (vertiefung-stufe-reset.test.js) kann das nicht sehen: dort ist
// generateQuiz synchron gestubbt. Hier laeuft die ECHTE Funktion in einer vm-Sandbox, und die
// Stubs der awaitenden Vorschritte aendern das Select mittendrin — genau der Angriffszeitpunkt.
// Kein Netz, kein Browser. Start: node test/gespraechsstufe-per-request.test.js

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Exakten Quelltext einer Funktion per Klammer-Balance ziehen. Zwei Unterschiede zu
// vertiefung-stufe-reset.test.js: ein fuehrendes "async" muss mit heraus (sonst faellt das erste
// await im Rumpf auf die Nase), und der Rumpf wird erst NACH der Parameterliste gesucht — bei
// `generateQuiz(opts = {})` waere sonst das leere Objekt im Default-Wert der "Rumpf".
function funcSrc(name) {
  const re = new RegExp("(?:async\\s+)?function " + name + "\\b");
  const m = re.exec(src);
  if (!m) throw new Error("nicht gefunden: function " + name);
  let i = src.indexOf("(", m.index), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) { i++; break; }
  }
  i = src.indexOf("{", i);
  depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { if (--depth === 0) return src.slice(m.index, i + 1); } }
  throw new Error("keine Klammer-Balance: " + name);
}

let failures = 0;
const assert = (cond, msg) => { if (cond) { console.log("  ok:", msg); } else { failures++; console.error("  FAIL:", msg); } };
const eq = (a, b, msg) => assert(a === b, `${msg} (erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)})`);

const JOBTEXT = "Stellenbeschreibung ".repeat(20); // > 50 Zeichen, sonst steigt generateQuiz frueh aus

// Sandbox mit genau den Abhaengigkeiten, die generateQuiz bis zum Hosted-Dispatch braucht.
// Gestubbt sind nur die Randbedingungen; die Stufen-Logik selbst kommt unveraendert aus app.js.
// opts.pauseAt bestimmt, WELCHER awaitende Vorschritt anhaelt und das Select umsetzt.
function freshSandbox({ stufe = "", learnSessionOffen = false, earlyStart = false, bezahlteStufe = false } = {}) {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext([
    // --- Beobachtung + steuerbare Pausen ---
    "var __calls = { hosted: [], track: [], errors: [] };",
    "var __pending = { learnConfirm: null };", // Callback der Lernsession-Rueckfrage
    "var __hooks = { onConfirmReplace: null, onRefreshBalance: null };",
    "var __els = {",
    "  'job-text': { value: " + JSON.stringify(JOBTEXT) + " },",
    "  'job-url': { value: '' },",
    "  'num-questions': { value: '10' },",
    "  'gespraechsstufe': { value: " + JSON.stringify(stufe) + " },",
    "};",
    "function $(id) { return __els[id] || null; }",
    "var document = {",
    "  getElementById(id) { return __els[id] || null; },",
    "  querySelector(sel) {",
    "    if (sel.indexOf('name=\"mode\"') >= 0) return { value: 'lernen' };",
    "    if (sel.indexOf('name=\"difficulty\"') >= 0) return { value: 'mittel' };",
    "    return null;",
    "  },",
    "};",
    // --- Randbedingungen ---
    "var actionRunning = false;",
    "var lastFetch = { url: '', text: '' };",
    "var settings = { provider: 'hosted', authToken: 'tok' };",
    "var NUM_MIN = 4;",
    "function numMax() { return 20; }",
    "function showError(m) { __calls.errors.push(m); }",
    "function hostedNeedsLogin() { return false; }",
    "function trackEvent(n) { __calls.track.push(n); }",
    "function urlKeyOf() { return null; }",
    "function profilePayload() { return undefined; }",
    "function returnToRunningAttempt() {}",
    "function clearLearnSession() {}",
    "function renderHome() {}",
    "function loadActiveJob() { return { jobId: 'j1' }; }",
    "function earlyStartAttemptRunning() { return " + JSON.stringify(!!earlyStart) + "; }",
    "function loadLearnSession() { return " + JSON.stringify(!!learnSessionOffen) + " ? { a: 1 } : null; }",
    // Awaitender Vorschritt 1: die Ersetzen-Rueckfrage.
    "async function openConfirmReplaceReady() {",
    "  if (__hooks.onConfirmReplace) await __hooks.onConfirmReplace();",
    "  return 'replace';",
    "}",
    // Die Lernsession-Rueckfrage ist NICHT awaited — sie reicht einen Callback nach draussen,
    // der spaeter (aus dem Dialog) feuert. Genau dieses Fenster testet Fall 4.
    "function openConfirmReplaceLearn(cb) { __pending.learnConfirm = cb; }",
    // Awaitender Vorschritt 2: die Guthaben-Aktualisierung vor einer bezahlten Stufe.
    "var creditsState = { loaded: true, dirty: false };",
    "function selectedTier() { return " + (bezahlteStufe ? "'standard'" : "'guenstig'") + "; }",
    "function tierIsFree(t) { return t === 'guenstig'; }",
    "function tierChargesNow() { return false; }",
    "function canAffordTier() { return true; }",
    "function tierLabelFor(t) { return t; }",
    "function serverOpusCredits() { return null; }",
    "function tierPriceCredits() { return null; }",
    "function formatGuthabenEuro() { return ''; }",
    "async function refreshBalance() {",
    "  if (__hooks.onRefreshBalance) await __hooks.onRefreshBalance();",
    "  creditsState.dirty = false;",
    "}",
    // Endpunkt: hier landet der Payload, den wir pruefen.
    "function startHostedGeneration(ctx) { __calls.hosted.push(ctx); }",
    // --- echte Logik aus app.js ---
    src.match(/^const GESPRAECHSSTUFEN = .*$/m)[0],
    funcSrc("normStufe"),
    funcSrc("gespraechsstufePayload"),
    funcSrc("clampNum"),
    funcSrc("generateQuiz"),
    "globalThis.__x = { generateQuiz, __els, __calls, __pending, __hooks };",
  ].join("\n"), sandbox);
  return sandbox.__x;
}

async function run() {
  // 1) Kernfall: waehrend der Ersetzen-Rueckfrage setzt eine andere Aktion das geteilte Select
  //    um. Der laufende Start muss trotzdem mit der urspruenglich gewaehlten Stufe absenden.
  {
    const x = freshSandbox({ stufe: "telefon", earlyStart: true });
    x.__hooks.onConfirmReplace = () => { x.__els["gespraechsstufe"].value = "assessment"; };
    await x.generateQuiz();
    eq(x.__calls.hosted.length, 1, "Rueckfrage-Fenster: es wird genau einmal dispatcht");
    eq(x.__calls.hosted[0].gespraechsstufe, "telefon",
      "Rueckfrage-Fenster: die beim Ausloesen gewaehlte Stufe wird versendet, nicht der Fremdwert");
    eq(x.__els["gespraechsstufe"].value, "assessment", "… das Select selbst bleibt unangetastet (fremde Aktion)");
  }

  // 2) Dasselbe im zweiten await-Fenster: der Guthaben-Refresh vor einer bezahlten Stufe.
  {
    const x = freshSandbox({ stufe: "assessment", bezahlteStufe: true });
    x.__hooks.onRefreshBalance = () => { x.__els["gespraechsstufe"].value = "telefon"; };
    await x.generateQuiz();
    eq(x.__calls.hosted.length, 1, "Guthaben-Fenster: es wird genau einmal dispatcht");
    eq(x.__calls.hosted[0].gespraechsstufe, "assessment",
      "Guthaben-Fenster: der bezahlte Lauf behaelt die urspruenglich gewaehlte Stufe");
  }

  // 3) "Allgemein" ist ein echter Wert, kein "nicht gesetzt": ein waehrenddessen gesetzter
  //    Fremdwert darf nicht nachtraeglich in einen Lauf ohne Stufe rutschen.
  {
    const x = freshSandbox({ stufe: "", earlyStart: true });
    x.__hooks.onConfirmReplace = () => { x.__els["gespraechsstufe"].value = "assessment"; };
    await x.generateQuiz();
    eq(x.__calls.hosted[0].gespraechsstufe, undefined,
      "Allgemein bleibt Allgemein (Feld weggelassen), auch wenn zwischendurch eine Stufe gesetzt wird");
  }

  // 4) Wiedereinstieg aus dem Lernsession-Dialog: der Callback feuert spaeter, das Select kann
  //    dann laengst ein anderer Wert sein. Die beim ersten Ausloesen festgehaltene Stufe zaehlt.
  {
    const x = freshSandbox({ stufe: "telefon", learnSessionOffen: true });
    await x.generateQuiz();
    eq(x.__calls.hosted.length, 0, "Lernsession offen: erst Rueckfrage, noch kein Dispatch");
    assert(typeof x.__pending.learnConfirm === "function", "Lernsession offen: Rueckfrage-Callback liegt vor");
    x.__els["gespraechsstufe"].value = "assessment"; // andere Aktion, waehrend der Dialog offen ist
    await x.__pending.learnConfirm();
    eq(x.__calls.hosted.length, 1, "nach Bestaetigung wird dispatcht");
    eq(x.__calls.hosted[0].gespraechsstufe, "telefon",
      "Wiedereinstieg uebernimmt die urspruenglich festgehaltene Stufe");
  }

  // 5) Ohne Fremdeinwirkung unveraendert: gewaehlte Stufe kommt an, ungueltige faellt weg.
  {
    const x = freshSandbox({ stufe: "assessment" });
    await x.generateQuiz();
    eq(x.__calls.hosted[0].gespraechsstufe, "assessment", "Normalfall: gewaehlte Stufe kommt an");
  }
  {
    const x = freshSandbox({ stufe: "leitung" }); // nicht mehr angeboten
    await x.generateQuiz();
    eq(x.__calls.hosted[0].gespraechsstufe, undefined, "nicht mehr angebotener Wert wird nicht gesendet");
  }

  // 6) startTestForJob gibt die Stufe der Stelle EXPLIZIT mit, statt sie ueber das geteilte
  //    Select laufen zu lassen — damit haengt der Lauf nicht mehr am DOM-Zustand. Das Select
  //    wird weiterhin gesetzt (sichtbare Anzeige der Maske).
  {
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext([
      "var __calls = { generateQuiz: [], track: [] };",
      "var actionRunning = false;",
      "var lastFetch = { url: '', text: '' };",
      "var __els = { 'job-text': { value: '' }, 'job-url': { value: '' },",
      "  'num-questions': { value: '' }, 'gespraechsstufe': { value: 'assessment' } };",
      "function $(id) { return __els[id] || null; }",
      "var document = { querySelector() { return { checked: false }; } };",
      "function setSourceTab() {}",
      "function saveDraft() {}",
      "function trackEvent(n) { __calls.track.push(n); }",
      "function generateQuiz(opts) { __calls.generateQuiz.push(opts); }",
      src.match(/^const GESPRAECHSSTUFEN = .*$/m)[0],
      funcSrc("normStufe"),
      funcSrc("startTestForJob"),
      "globalThis.__x = { startTestForJob, __els, __calls };",
    ].join("\n"), sandbox);
    const x = sandbox.__x;

    x.startTestForJob({ jobText: "T" }, "lernen", { difficulty: "mittel", num: 10, stufe: "telefon" });
    eq(x.__calls.generateQuiz.length, 1, "startTestForJob startet die Generierung");
    eq(x.__calls.generateQuiz[0] && x.__calls.generateQuiz[0].gespraechsstufe, "telefon",
      "startTestForJob reicht die Stufe der Stelle explizit durch");
    eq(x.__els["gespraechsstufe"].value, "telefon", "… und setzt das Select fuer die Anzeige mit");

    // Stelle ohne (gueltige) Stufe: explizit "" = Allgemein, nicht der Rest aus der Maske.
    x.__els["gespraechsstufe"].value = "assessment";
    x.startTestForJob({ jobText: "T" }, "lernen", { difficulty: "mittel", num: 10, stufe: "leitung" });
    eq(x.__calls.generateQuiz[1].gespraechsstufe, "", "ungueltige gemerkte Stufe → explizit '' (Allgemein)");
    eq(x.__els["gespraechsstufe"].value, "", "… Select ebenfalls zurueckgesetzt");
  }

  console.log(failures === 0 ? "\nAlle Checks bestanden." : `\n${failures} Check(s) fehlgeschlagen.`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
