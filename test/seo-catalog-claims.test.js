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
// unbeteiligten Textaenderung.
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

// Sammelt alle Freitext-Strings einer Seite: intro, tipps, faq (q/a),
// samples (question/answer/options), sections (heading/paragraphs/items/
// examples q+a/links label).
function collectTexts(cat) {
  const texts = [];
  for (const p of cat.pages || []) {
    if (typeof p.intro === "string") texts.push(p.intro);
    for (const t of p.tipps || []) if (typeof t === "string") texts.push(t);
    for (const f of p.faq || []) {
      if (typeof f.q === "string") texts.push(f.q);
      if (typeof f.a === "string") texts.push(f.a);
    }
    for (const s of p.samples || []) {
      if (typeof s.question === "string") texts.push(s.question);
      if (typeof s.answer === "string") texts.push(s.answer);
      for (const o of s.options || []) if (typeof o === "string") texts.push(o);
    }
    for (const sec of p.sections || []) {
      if (typeof sec.heading === "string") texts.push(sec.heading);
      for (const para of sec.paragraphs || []) if (typeof para === "string") texts.push(para);
      for (const it of sec.items || []) if (typeof it === "string") texts.push(it);
      for (const ex of sec.examples || []) {
        if (typeof ex.q === "string") texts.push(ex.q);
        if (typeof ex.a === "string") texts.push(ex.a);
      }
      for (const l of sec.links || []) if (typeof l.label === "string") texts.push(l.label);
    }
  }
  return texts;
}

// Grobe Satzsegmentierung an . ! ? - reicht fuer dieses enge Muster.
function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function run() {
  const catalogPath = path.join(__dirname, "..", "seo", "catalog.json");
  const cat = JSON.parse(fs.readFileSync(catalogPath, "utf8"));

  let checked = 0;
  for (const text of collectTexts(cat)) {
    for (const sentence of splitSentences(text)) {
      const lower = sentence.toLowerCase();
      if (!lower.includes("ohne anmeldung") && !lower.includes("ohne login")) continue;
      checked++;
      assert(
        !sentence.includes("Sprachlogik"),
        `Satz mit "ohne Anmeldung"/"ohne Login" nennt nicht "Sprachlogik": ${JSON.stringify(sentence)}`
      );
    }
  }
  assert(checked > 0, 'mindestens ein Satz mit "ohne Anmeldung"/"ohne Login" wurde tatsächlich geprüft');

  console.log(failures === 0 ? "\nALLE TESTS OK" : `\n${failures} FEHLER`);
  if (failures > 0) process.exit(1);
}

run();
