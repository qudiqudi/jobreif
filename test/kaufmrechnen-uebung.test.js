"use strict";

// Uebungsmodul "Kaufmaennisches Rechnen" (generateKaufmRechnenUebung, app.js) — Regression
// fuer die Kern-Zusicherung: JEDES erzeugte Aufgabenrezept liefert eine ganze, nicht-negative
// Zahl als korrekte_antwort (nie Rundung, nie float-Rauschen), und nicht-leere frage/lerninfo.
// Testet die ECHTE Funktion: extrahiert sie per Klammer-Balance aus ../app.js und evaluiert
// sie in einer vm-Sandbox zusammen mit ihren echten Abhaengigkeiten uebRandInt/uebPick (kein
// Reimplementierungs-Drift, gleiches Muster wie funnel-job-started.test.js). Kein Netz, kein
// Browser.
// Start: node test/kaufmrechnen-uebung.test.js

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

// ===================== Sandbox mit der echten Generatorfunktion + Abhaengigkeiten =====================
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  funcSrc("uebRandInt"),
  funcSrc("uebPick"),
  funcSrc("generateKaufmRechnenUebung"),
  "globalThis.__gen = generateKaufmRechnenUebung;",
].join("\n\n"), sandbox);

// ===================== 1) Massenerzeugung: >= 500 Aufgaben, alle strukturell gueltig =====================
const N = 2000;
const frageSet = new Set();
let allTyp = true;
let allAntwortenGanzzahlig = true;
let allFrageNichtLeer = true;
let allLerninfoNichtLeer = true;
let minAntwort = Infinity;

// Bewusst OHNE Assert pro Iteration (2000 Läufe): einzelne Verstöße sammeln sich in den
// Flags/Listen unten und werden als EINE aussagekräftige Zusicherung pro Kriterium geprüft -
// sonst würde die CI-Ausgabe mit 2000 "ok"-Zeilen pro Kriterium überflutet.
for (let i = 0; i < N; i++) {
  const q = sandbox.__gen();
  if (!q || typeof q !== "object" || q.typ !== "kaufmrechnen") allTyp = false;
  const ans = Number(q.korrekte_antwort);
  if (!Number.isFinite(ans) || !Number.isInteger(ans) || ans < 0) allAntwortenGanzzahlig = false;
  if (ans < minAntwort) minAntwort = ans;
  if (typeof q.frage !== "string" || !q.frage.trim()) allFrageNichtLeer = false;
  if (typeof q.lerninfo !== "string" || !q.lerninfo.trim()) allLerninfoNichtLeer = false;
  frageSet.add(q.frage);
}

assert(allTyp, `alle ${N} Aufgaben sind Objekte mit typ === "kaufmrechnen"`);
assert(allAntwortenGanzzahlig, `alle ${N} Antworten sind endliche, nicht-negative Ganzzahlen`);
assert(minAntwort >= 0 && Number.isFinite(minAntwort), "kleinste erzeugte Antwort ist >= 0");
assert(allFrageNichtLeer, `alle ${N} Fragen sind nicht-leer`);
assert(allLerninfoNichtLeer, `alle ${N} Lerninfos sind nicht-leer`);
assert(frageSet.size > N / 10, `ausreichende Aufgabenvielfalt (${frageSet.size} unterschiedliche Fragen bei ${N} Läufen)`);

// ===================== 2) Alle Rezepte kommen vor (anhand charakteristischer Marker im Lerninfo/Frage) =====================
// Jeder Marker ist so gewaehlt, dass er NUR im jeweiligen Rezept auftaucht - Nachweis, dass
// keines der Rezepte im "uebPick"-Array tot ist (z. B. durch einen Copy-Paste-Fehler).
const markers = {
  "Prozentwert (Bearbeitungsgebühr)": /als Bearbeitungsgebühr berechnet/,
  "Prozentsatz": /entspricht einem Anteil von/,
  "Grundwert": /Wie hoch ist die gesamte Rechnungssumme/,
  "Dreisatz proportional (Kartons)": /Kartons enthalten/,
  "Dreisatz antiproportional (Arbeiter\/Tage)": /Arbeiter erledigen einen Auftrag/,
  "Rabatt": /Bei \d+ % Rabatt: Wie viel/,
  "Skonto": /mit \d+ % Skonto beglichen\. Welchen Betrag/,
  "Rabatt + Skonto nacheinander": /Rabatt und danach \d+ % Skonto/,
  "MwSt netto→brutto": /Wie hoch ist der Bruttopreis bei 19 % Mehrwertsteuer/,
  "MwSt brutto→netto": /enthält 19 % Mehrwertsteuer\. Wie hoch ist der Nettopreis/,
  "Jahreszinsen": /Zinsen pro Jahr angelegt/,
  "Währungsumrechnung": /angenommenen Kurs von 1 €/,
};

const hitCounts = {};
for (const key of Object.keys(markers)) hitCounts[key] = 0;
// Frischer, groesserer Lauf fuer den Abdeckungsnachweis (unabhaengig vom obigen Sample).
const M = 4000;
for (let i = 0; i < M; i++) {
  const q = sandbox.__gen();
  for (const [key, re] of Object.entries(markers)) {
    if (re.test(q.frage)) hitCounts[key]++;
  }
}
for (const [key, count] of Object.entries(hitCounts)) {
  assert(count > 0, `Rezept "${key}" wurde mindestens einmal erzeugt (${count}× in ${M} Läufen)`);
}

console.log(failures === 0 ? "\nAlle Checks bestanden." : `\n${failures} Check(s) fehlgeschlagen.`);
process.exit(failures === 0 ? 0 : 1);
