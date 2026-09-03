"use strict";

// Wächter-Test (Codex-Review zu 7e26044, Befund 2): der punktuelle Duplikat-
// Check der SEO-Welle Punkt 6 (Katalogerweiterung auf 29 Berufe) fand erst ab
// 8 Wörtern - zwei FAQ-Fragen waren wortgleich zwischen neuen Seiten ("Wie
// läuft das Auswahlverfahren üblicherweise/typischerweise ab?"), blieben aber
// unter der Schwelle unentdeckt. Dieser Test bleibt dauerhaft im Repo (wird
// von `node --test` automatisch mit eingesammelt, siehe .github/workflows/
// ci.yml) und prüft ab 6 Wörtern.
//
// Geprüft werden vollständige, normalisierte Sätze (nicht bloß Wortfolgen
// innerhalb eines Satzes) aus den nutzersichtbaren Feldern: intro, tipps,
// faq (q/a), samples (question/answer/options), sections (heading/
// paragraphs/items/examples q+a/links label) sowie dieselben Felder auf dem
// Hub. Absichtlich NICHT geprüft: title/seoTitle/description/beruf/uebungen-
// Label - diese folgen einem festen Muster ("Kostenlos üben: Einstellungstest
// <Beruf> ...") und würden allein durch den eingesetzten Beruf-Namen ohnehin
// nie exakt übereinstimmen, aber bei kurzen Berufsnamen fälschlich unter die
// Wortgrenze fallen und Rauschen erzeugen.
//
// "Gleiche Struktur ist ok, gleiche Sätze nicht": zwei Seiten dürfen dieselbe
// FAQ-Frage-Vorlage nutzen, wenn der Beruf im Satz genannt wird (dann sind es
// unterschiedliche Sätze) - identische Sätze ohne Beruf-Unterscheidung nicht.
//
// Start: node test/seo-catalog-duplicates.test.js

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

const MIN_WORDS = 6;

// Normalisierung: Kleinschreibung, Satzzeichen entfernt, Whitespace
// zusammengezogen. Buchstaben (inkl. Umlaute/ß) und Ziffern bleiben stehen,
// alles andere wird zu einem Trennzeichen.
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function wordCount(normalized) {
  return normalized ? normalized.split(" ").filter(Boolean).length : 0;
}

// Bekannte deutsche Abkuerzungen mit Punkt, die KEIN Satzende sind (z. B.,
// bzw., d. h., ...). Ohne Schutz splittet die grobe "."-Heuristik unten
// mitten im Satz (z. B. "... in z. B. 10 oder 20 Teile ...") und erzeugt
// Bruchstuecke, die zufaellig mit einem anderen Bruchstueck uebereinstimmen -
// ein Artefakt der Segmentierung, kein echtes Inhalts-Duplikat. Der Punkt
// bleibt stehen, nur der nachfolgende Whitespace (an dem splitSentences
// trennt) wird durch einen Platzhalter ersetzt und danach zurueckgetauscht.
const ABBREVIATIONS = [
  /\bz\.\s*B\.\s+/g,
  /\bbzw\.\s+/g,
  /\bd\.\s*h\.\s+/g,
  /\bu\.\s*a\.\s+/g,
  /\bu\.\s*U\.\s+/g,
  /\bz\.\s*T\.\s+/g,
  /\busw\.\s+/g,
  /\betc\.\s+/g,
  /\bggf\.\s+/g,
  /\bca\.\s+/g,
  /\bNr\.\s+/g,
  /\bArt\.\s+/g,
  /\bAbs\.\s+/g,
  /\bStd\.\s+/g,
  /\binkl\.\s+/g,
  /\bexkl\.\s+/g,
  /\bsog\.\s+/g,
  /\bvgl\.\s+/g,
  /\bo\.\s*ä\.\s+/g,
  /\bff\.\s+/g,
];
const ABBR_MARKER = "";
function protectAbbreviations(text) {
  let out = text;
  // ALLE Whitespace-Stellen im Treffer schuetzen, nicht nur die letzte: "z. B. "
  // hat selbst schon einen inneren Punkt+Leerzeichen ("z." vor "B."), der sonst
  // trotzdem einen Satzumbruch ausloesen wuerde.
  for (const re of ABBREVIATIONS) out = out.replace(re, (m) => m.replace(/\s+/g, ABBR_MARKER));
  return out;
}

// Grobe Satzsegmentierung an . ! ? - dasselbe Muster wie in
// test/seo-catalog-claims.test.js, zusaetzlich abkuerzungsgeschuetzt (siehe
// oben). Kurze Phrasen ohne Satzzeichen (z. B. samples[].options,
// sections[].items) bleiben dabei als ein "Satz" stehen.
function splitSentences(text) {
  return protectAbbreviations(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().replace(new RegExp(ABBR_MARKER, "g"), " "))
    .filter(Boolean);
}

// Sammelt {raw, field}-Paare aus den zu prüfenden Feldern EINER Berufsseite.
// Bewusst schmaler als collectTexts() in seo-catalog-claims.test.js (siehe
// Kommentar oben): kein title/seoTitle/description/beruf/uebungen-Label.
function collectPageEntries(p) {
  const out = [];
  const push = (field, v) => { if (typeof v === "string" && v.trim()) out.push({ field, raw: v }); };
  push("intro", p.intro);
  (p.tipps || []).forEach((t, i) => push(`tipps[${i}]`, t));
  (p.faq || []).forEach((f, i) => { push(`faq[${i}].q`, f && f.q); push(`faq[${i}].a`, f && f.a); });
  (p.samples || []).forEach((s, i) => {
    push(`samples[${i}].question`, s && s.question);
    push(`samples[${i}].answer`, s && s.answer);
    (s && s.options || []).forEach((o, j) => push(`samples[${i}].options[${j}]`, o));
  });
  collectSectionEntries(p.sections, out, "sections");
  return out;
}
function collectSectionEntries(sections, out, prefix) {
  (sections || []).forEach((sec, i) => {
    const push = (field, v) => { if (typeof v === "string" && v.trim()) out.push({ field, raw: v }); };
    push(`${prefix}[${i}].heading`, sec && sec.heading);
    (sec && sec.paragraphs || []).forEach((t, j) => push(`${prefix}[${i}].paragraphs[${j}]`, t));
    (sec && sec.items || []).forEach((t, j) => push(`${prefix}[${i}].items[${j}]`, t));
    (sec && sec.examples || []).forEach((ex, j) => {
      push(`${prefix}[${i}].examples[${j}].q`, ex && ex.q);
      push(`${prefix}[${i}].examples[${j}].a`, ex && ex.a);
    });
    (sec && sec.links || []).forEach((l, j) => push(`${prefix}[${i}].links[${j}].label`, l && l.label));
  });
}
function collectHubEntries(hub) {
  const out = [];
  if (!hub) return out;
  const push = (field, v) => { if (typeof v === "string" && v.trim()) out.push({ field, raw: v }); };
  push("title", hub.title);
  push("seoTitle", hub.seoTitle);
  push("description", hub.description);
  push("lead", hub.lead);
  collectSectionEntries(hub.sections, out, "sections");
  (hub.faq || []).forEach((f, i) => { push(`faq[${i}].q`, f.q); push(`faq[${i}].a`, f.a); });
  return out;
}

// Baut den vollstaendigen Satz-Index ueber den GANZEN Katalog: jede Zeile ist
// {norm, raw, slug, field}. slug ist "hub" fuer den Ratgeber.
function buildSentenceIndex(cat) {
  const index = [];
  for (const p of cat.pages || []) {
    for (const { field, raw } of collectPageEntries(p)) {
      for (const sentence of splitSentences(raw)) {
        const norm = normalize(sentence);
        if (wordCount(norm) >= MIN_WORDS) index.push({ norm, raw: sentence, slug: p.slug, field });
      }
    }
  }
  for (const { field, raw } of collectHubEntries(cat.hub)) {
    for (const sentence of splitSentences(raw)) {
      const norm = normalize(sentence);
      if (wordCount(norm) >= MIN_WORDS) index.push({ norm, raw: sentence, slug: "hub", field });
    }
  }
  return index;
}

// Samples-Index einer Zeile "samples[3].answer" -> "3", sonst null.
function sampleIndexOf(field) {
  const m = /^samples\[(\d+)\]/.exec(field);
  return m ? m[1] : null;
}

// Absichtlicher Sonderfall, KEIN Duplikat: der "answer"-Text einer Aufgabe
// beginnt katalogweit ueblicherweise mit dem woertlichen Text der richtigen
// "options[]"-Antwort ("<Optionstext> - <Begruendung>"), damit die richtige
// Antwort eindeutig erkennbar ist. Das erzeugt zwangslaeufig denselben vollen
// Satz zweimal INNERHALB derselben Aufgabe (options[j] und answer). Das ist
// gewolltes Seitendesign, keine kopierte Seiteninhalt-Dopplung - deshalb hier
// ausgenommen: eine Gruppe zaehlt nur als Verstoss, wenn sie NICHT vollstaendig
// aus Feldern derselben (slug, samples[i]) besteht.
function isSelfSampleEcho(entries) {
  const first = entries[0];
  const idx = sampleIndexOf(first.field);
  if (idx === null) return false;
  return entries.every((e) => e.slug === first.slug && sampleIndexOf(e.field) === idx);
}

// Gruppiert den Index nach normalisiertem Satz und liefert alle Gruppen mit
// mehr als einem Fundort (= Duplikate), abzueglich des Sonderfalls oben.
function findDuplicateGroups(index) {
  const bySentence = new Map();
  for (const entry of index) {
    if (!bySentence.has(entry.norm)) bySentence.set(entry.norm, []);
    bySentence.get(entry.norm).push(entry);
  }
  const groups = [];
  for (const entries of bySentence.values()) {
    if (entries.length > 1 && !isSelfSampleEcho(entries)) groups.push(entries);
  }
  return groups;
}

function run() {
  // 1) Negativproben: der Test muss ein konstruiertes Duplikat wirklich finden.
  {
    const fixture = {
      pages: [
        { slug: "a", faq: [{ q: "Frage A?", a: "Dies ist ein Satz mit genug Woertern drin." }] },
        { slug: "b", faq: [{ q: "Frage B?", a: "Dies ist ein Satz mit genug Woertern drin." }] },
      ],
    };
    const groups = findDuplicateGroups(buildSentenceIndex(fixture));
    assert(groups.length === 1 && groups[0].length === 2, "Negativprobe: identischer Satz (>= 6 Woerter) in zwei Seiten wird erkannt");
  }
  // 1b) Groß-/Kleinschreibung und Satzzeichen duerfen ein Duplikat nicht verstecken.
  {
    const fixture = {
      pages: [
        { slug: "a", intro: "Dies ist ein Testsatz mit sieben Woertern total." },
        { slug: "b", intro: "dies ist ein TESTSATZ, mit sieben Woertern total!" },
      ],
    };
    const groups = findDuplicateGroups(buildSentenceIndex(fixture));
    assert(groups.length === 1, "Negativprobe: Gross-/Kleinschreibung + Satzzeichen werden normalisiert erkannt");
  }
  // 1c) Unter 6 Woertern wird NICHT als Duplikat gemeldet.
  {
    const fixture = {
      pages: [
        { slug: "a", tipps: ["Kurzer Satz mit fuenf Woertern."] },
        { slug: "b", tipps: ["Kurzer Satz mit fuenf Woertern."] },
      ],
    };
    const groups = findDuplicateGroups(buildSentenceIndex(fixture));
    assert(groups.length === 0, "Positivprobe: Satz mit < 6 Woertern wird nicht geprueft");
  }
  // 1d) Gleiche Struktur, unterschiedlicher Beruf im Satz -> kein Duplikat.
  {
    const fixture = {
      pages: [
        { slug: "a", faq: [{ q: "Wie laeuft das Auswahlverfahren fuer Beruf A ueblicherweise ab?", a: "x" }] },
        { slug: "b", faq: [{ q: "Wie laeuft das Auswahlverfahren fuer Beruf B ueblicherweise ab?", a: "x" }] },
      ],
    };
    const groups = findDuplicateGroups(buildSentenceIndex(fixture));
    assert(groups.length === 0, "Positivprobe: gleiche Satzstruktur mit unterschiedlichem Beruf im Satz ist kein Duplikat");
  }
  // 1e) title/description werden NICHT geprueft (bewusst ausgeklammert, siehe oben).
  {
    const fixture = {
      pages: [
        { slug: "a", title: "Ein Titel mit ausreichend vielen Woertern hier" },
        { slug: "b", title: "Ein Titel mit ausreichend vielen Woertern hier" },
      ],
    };
    const groups = findDuplicateGroups(buildSentenceIndex(fixture));
    assert(groups.length === 0, "Positivprobe: identischer title wird nicht geprueft (nicht im Feldumfang)");
  }
  // 1f) Duplikat innerhalb des Hub UND zwischen Hub und einer Seite wird erkannt.
  {
    const fixture = {
      pages: [{ slug: "a", intro: "Dieser Satz kommt auch im Hub wortgleich vor." }],
      hub: { lead: "Dieser Satz kommt auch im Hub wortgleich vor." },
    };
    const groups = findDuplicateGroups(buildSentenceIndex(fixture));
    assert(groups.length === 1 && groups[0].some((e) => e.slug === "hub"), "Negativprobe: Duplikat zwischen Seite und Hub wird erkannt");
  }
  // 1g) Sonderfall answer/options[] DERSELBEN Aufgabe: kein Verstoss.
  {
    const fixture = {
      pages: [{
        slug: "a",
        samples: [{
          type: "fachwissen",
          question: "Q?",
          options: ["Dies ist die richtige, ausfuehrlich formulierte Option.", "x", "y", "z"],
          answer: "Dies ist die richtige, ausfuehrlich formulierte Option. Und hier die Begruendung.",
        }],
      }],
    };
    const groups = findDuplicateGroups(buildSentenceIndex(fixture));
    assert(groups.length === 0, "Positivprobe: answer wiederholt die eigene options[]-Antwort derselben Aufgabe (gewolltes Design, kein Duplikat)");
  }
  // 1h) Dieselbe Wortfolge in Aufgabe 0 und Aufgabe 1 DERSELBEN Seite ist
  // dagegen ein echter Verstoss (kein Selbstecho, andere Aufgabe).
  {
    const fixture = {
      pages: [{
        slug: "a",
        samples: [
          { type: "fachwissen", question: "Q1?", answer: "Ein wiederholter Satz mit genug Woertern total." },
          { type: "fachwissen", question: "Q2?", answer: "Ein wiederholter Satz mit genug Woertern total." },
        ],
      }],
    };
    const groups = findDuplicateGroups(buildSentenceIndex(fixture));
    assert(groups.length === 1, "Negativprobe: identischer Satz in zwei VERSCHIEDENEN Aufgaben derselben Seite wird erkannt");
  }
  // 1i) Abkuerzungen wie "z. B." und "bzw." duerfen keinen falschen Split
  // erzeugen (Regressionsschutz fuer protectAbbreviations()).
  {
    const sentences = splitSentences("Dies ist ein langer Satz mit einer Abkuerzung z. B. mittendrin und geht noch weiter.");
    assert(sentences.length === 1, `splitSentences: "z. B." erzeugt keinen Satzumbruch (war ${sentences.length} Teile: ${JSON.stringify(sentences)})`);
  }
  {
    const sentences = splitSentences("Erste Aussage bzw. Umformulierung geht hier weiter. Zweiter echter Satz beginnt hier.");
    assert(sentences.length === 2, `splitSentences: "bzw." erzeugt keinen Satzumbruch, ein echtes Satzende danach schon (war ${sentences.length} Teile: ${JSON.stringify(sentences)})`);
  }

  // 2) Echter Katalog.
  const catalogPath = path.join(__dirname, "..", "seo", "catalog.json");
  const cat = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const index = buildSentenceIndex(cat);
  assert(index.length > 0, "mindestens ein Satz (>= 6 Woerter) wurde tatsaechlich geprueft");
  const groups = findDuplicateGroups(index);
  if (groups.length > 0) {
    for (const g of groups) {
      console.error(`  FAIL: Satz mehrfach im Katalog: "${g[0].raw}"`);
      for (const e of g) console.error(`        - ${e.slug} (${e.field})`);
    }
  }
  assert(groups.length === 0, `katalogweit ist jeder vollstaendige Satz (>= 6 Woerter) eindeutig (${index.length} Saetze geprueft, ${groups.length} Duplikat-Gruppe(n))`);

  console.log(failures === 0 ? "\nALLE TESTS OK" : `\n${failures} FEHLER`);
  if (failures > 0) process.exit(1);
}

run();
