"use strict";

// Regressionstest (Codex-Review Runde 3 zu Commit 6d62dda): keine Aufzaehlung
// anmeldefreier Uebungsmodule im SEO-Katalog darf "Sprachlogik" nennen.
// Sprachlogik ist Teil des kompletten, stellenbezogenen Tests und braucht die
// kostenlose Anmeldung (siehe lernen/index.html); anmeldefrei sind nur die in
// UEB_TYPEN (app.js) registrierten Module (Figuren/Matrizen, Zahlenreihen,
// Konzentration, Kopfrechnen, Kaufmaennisches Rechnen, Buchstabenreihen,
// Merkfaehigkeit, Rechtschreibung, Assoziationen).
//
// Bewusst schmal gehalten: prueft NUR dieses eine Muster (ein Satz mit "ohne
// Anmeldung" oder "ohne Login" darf "Sprachlogik" nicht enthalten), nicht
// jede inhaltliche Aussage im Katalog - sonst bricht der Test bei jeder
// unbeteiligten Textaenderung. Erfasst werden ALLE nutzersichtbaren Felder
// einer Seite (auch title/description/beruf/uebungen) sowie die Testarten-Texte
// (testTypes label/description), der Vergleich ist schreibungsunabhaengig.
// Negativproben je Renderpfad sichern den Test selbst ab.
//
// Start: node test/seo-catalog-claims.test.js

const fs = require("fs");
const path = require("path");

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ok:", msg);
    return;
  }
  failures++;
  console.error("  FAIL:", msg);
}

// Sammelt alle nutzersichtbaren Strings: testTypes (label/description) sowie je
// Seite title, description, beruf, intro, uebungen label, tipps, faq (q/a),
// samples (question/answer/options/note), sections (heading/paragraphs/items/
// examples q+a/links label) - UND (SEO-Welle Punkt 5) dieselben Felder auf dem
// optionalen Hub (cat.hub: title/seoTitle/description/lead/sections/faq). Eine
// eigene collectSections()-Hilfsfunktion vermeidet, die sections-Extraktion
// zweimal (pages[] und hub) auszuschreiben.
function collectSectionTexts(sections, push) {
  for (const sec of sections || []) {
    push(sec.heading);
    for (const para of sec.paragraphs || []) push(para);
    for (const it of sec.items || []) push(it);
    for (const ex of sec.examples || []) { push(ex.q); push(ex.a); }
    for (const l of sec.links || []) push(l.label);
  }
}
function collectTexts(cat) {
  const texts = [];
  const push = (v) => { if (typeof v === "string") texts.push(v); };
  // Testarten-Texte erscheinen auf jeder Seite, die den Typ nennt.
  for (const tt of Object.values(cat.testTypes || {})) { push(tt && tt.label); push(tt && tt.description); }
  for (const p of cat.pages || []) {
    push(p.title); push(p.description); push(p.beruf); push(p.intro);
    for (const u of p.uebungen || []) push(u && u.label);
    for (const t of p.tipps || []) push(t);
    for (const f of p.faq || []) { push(f.q); push(f.a); }
    for (const s of p.samples || []) {
      push(s.question); push(s.answer); push(s.note);
      for (const o of s.options || []) push(o);
    }
    collectSectionTexts(p.sections, push);
  }
  if (cat.hub) {
    push(cat.hub.title); push(cat.hub.seoTitle); push(cat.hub.description); push(cat.hub.lead);
    collectSectionTexts(cat.hub.sections, push);
    for (const f of cat.hub.faq || []) { push(f.q); push(f.a); }
  }
  return texts;
}

// Grobe Satzsegmentierung an . ! ? - reicht fuer dieses enge Muster.
function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

// Liefert { checked, violations }: alle Saetze mit "ohne Anmeldung"/"ohne Login",
// die (schreibungsunabhaengig) "sprachlogik" enthalten.
function findViolations(cat) {
  let checked = 0;
  const violations = [];
  for (const text of collectTexts(cat)) {
    for (const sentence of splitSentences(text)) {
      const lower = sentence.toLowerCase();
      if (!lower.includes("ohne anmeldung") && !lower.includes("ohne login")) continue;
      checked++;
      if (lower.includes("sprachlogik")) violations.push(sentence);
    }
  }
  return { checked, violations };
}

function run() {
  // 1) Negativproben: der Test muss diese Faelle wirklich erkennen.
  const fixtureDescription = { pages: [{ description: "Sprachlogik übst du ohne Anmeldung." }] };
  const fixtureLowercase = { pages: [{ intro: "Auch sprachlogik trainierst du hier ohne Login, jederzeit." }] };
  const fixtureTitle = { pages: [{ title: "Sprachlogik ohne Anmeldung üben" }] };
  const fixtureClean = { pages: [{ faq: [{ q: "Kostenlos?", a: "Zahlenreihen und Assoziationen übst du ohne Anmeldung. Sprachlogik ist Teil des kompletten Tests." }] }] };
  assert(findViolations(fixtureDescription).violations.length === 1, "Negativprobe: description mit Sprachlogik + ohne Anmeldung wird erkannt");
  assert(findViolations(fixtureLowercase).violations.length === 1, "Negativprobe: kleingeschriebenes sprachlogik + ohne Login wird erkannt");
  assert(findViolations(fixtureTitle).violations.length === 1, "Negativprobe: title mit Sprachlogik + ohne Anmeldung wird erkannt");
  assert(findViolations(fixtureClean).violations.length === 0, "Positivprobe: Sprachlogik in einem anderen Satz ist erlaubt");
  const fixtureTestType = { testTypes: { sprachlogik: { label: "Sprachlogik", description: "Sprachlogik übst du ohne Anmeldung." } }, pages: [] };
  const fixtureUebung = { pages: [{ uebungen: [{ href: "/lernen/x.html", label: "Sprachlogik ohne Login" }] }] };
  assert(findViolations(fixtureTestType).violations.length === 1, "Negativprobe: testTypes.description mit Sprachlogik + ohne Anmeldung wird erkannt");
  assert(findViolations(fixtureUebung).violations.length === 1, "Negativprobe: uebungen.label mit Sprachlogik + ohne Login wird erkannt");

  // 1b) Negativproben fuer den Hub (SEO-Welle Punkt 5): collectTexts() muss
  // cat.hub mit erfassen - title/lead ebenso wie sections und faq.
  const fixtureHubLead = { hub: { lead: "Sprachlogik übst du hier ohne Anmeldung." } };
  const fixtureHubSection = { hub: { sections: [{ heading: "H", paragraphs: ["Sprachlogik trainierst du ohne Login."] }] } };
  const fixtureHubFaq = { hub: { faq: [{ q: "Kostenlos?", a: "Sprachlogik übst du ohne Anmeldung." }] } };
  const fixtureHubClean = { hub: { title: "Einstellungstest für die Ausbildung", faq: [{ q: "Kostenlos?", a: "Zahlenreihen übst du ohne Anmeldung. Sprachlogik ist Teil des kompletten Tests." }] } };
  assert(findViolations(fixtureHubLead).violations.length === 1, "Negativprobe: hub.lead mit Sprachlogik + ohne Anmeldung wird erkannt");
  assert(findViolations(fixtureHubSection).violations.length === 1, "Negativprobe: hub.sections[].paragraphs mit Sprachlogik + ohne Login wird erkannt");
  assert(findViolations(fixtureHubFaq).violations.length === 1, "Negativprobe: hub.faq mit Sprachlogik + ohne Anmeldung wird erkannt");
  assert(findViolations(fixtureHubClean).violations.length === 0, "Positivprobe: hub-Sprachlogik in einem anderen Satz ist erlaubt");

  // 2) Echter Katalog.
  const catalogPath = path.join(__dirname, "..", "seo", "catalog.json");
  const cat = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const { checked, violations } = findViolations(cat);
  assert(checked > 0, 'mindestens ein Satz mit "ohne Anmeldung"/"ohne Login" wurde tatsächlich geprüft');
  assert(
    violations.length === 0,
    `kein Satz mit "ohne Anmeldung"/"ohne Login" nennt "Sprachlogik" (${checked} Sätze geprüft)` +
      (violations.length ? `: ${violations.map((v) => JSON.stringify(v)).join(" | ")}` : "")
  );

  console.log(failures === 0 ? "\nALLE TESTS OK" : `\n${failures} FEHLER`);
  if (failures > 0) process.exit(1);
}

run();
