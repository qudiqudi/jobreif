"use strict";

// Regression fuer die interne Link-Validierung im SEO-Generator
// (scripts/generate-seo.mjs, validate() -> uebungen[].href und
// sections[].links[].href): ein zu laxer Guard (nur "startsWith('/')") liesse
// protokollrelative Verweise wie "//evil.example/x" durch UND lehnte gueltige
// interne Ziele wie andere generierte Berufsseiten faelschlich ab, weil nur
// staticPages als bekannte Ziele zaehlten.
//
// generate-seo.mjs ist ein ES-Modul; diese Datei bleibt bewusst CommonJS
// (wie die anderen Testdateien in diesem Ordner) und laedt validate() per
// dynamischem import() nach.
//
// Start: node test/seo-link-validation.test.js

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log("  ok:", msg);
    return;
  }
  failures++;
  console.error("  FAIL:", msg);
}

// Minimaler, sonst gueltiger Katalog mit zwei Berufsseiten - genug, um sowohl
// staticPages- als auch pages-Ziele (Querverweis auf die jeweils andere Seite)
// zu pruefen.
function baseCatalog() {
  return {
    version: 1,
    baseUrl: "https://example.test",
    updatedAt: "2026-01-01",
    staticPages: [{ loc: "/lernen/x.html", lastmod: "2026-01-01" }],
    testTypes: { fachwissen: { label: "Fachwissen", description: "Testet Fachwissen." } },
    pages: [
      {
        slug: "beruf-a",
        beruf: "Beruf A",
        title: "Titel A",
        description: "Beschreibung A",
        intro: "Intro A",
        testTypes: ["fachwissen"],
        lastmod: "2026-01-01",
      },
      {
        slug: "beruf-b",
        beruf: "Beruf B",
        title: "Titel B",
        description: "Beschreibung B",
        intro: "Intro B",
        testTypes: ["fachwissen"],
        lastmod: "2026-01-01",
      },
    ],
  };
}

async function run() {
  const mod = await import("../scripts/generate-seo.mjs");
  const { validate } = mod;
  assert(typeof validate === "function", "validate() ist exportiert");

  const BAD_HREFS = ["//evil.example/x", "\\x", "/x?y", "/x#y", "https://evil.example/x", "not-a-slash"];
  for (const href of BAD_HREFS) {
    // a) uebungen[].href
    {
      const cat = baseCatalog();
      cat.pages[0].uebungen = [{ href, label: "L" }];
      const errs = validate(cat);
      assert(errs.length > 0, `uebungen.href "${href}" wird abgelehnt`);
    }
    // b) sections[].links[].href
    {
      const cat = baseCatalog();
      cat.pages[0].sections = [{ heading: "H", paragraphs: ["p"], links: [{ href, label: "L" }] }];
      const errs = validate(cat);
      assert(errs.length > 0, `sections[].links.href "${href}" wird abgelehnt`);
    }
  }

  // c) gueltige staticPages-loc wird weiterhin akzeptiert (uebungen)
  {
    const cat = baseCatalog();
    cat.pages[0].uebungen = [{ href: "/lernen/x.html", label: "L" }];
    const errs = validate(cat);
    assert(errs.length === 0, "uebungen.href auf staticPages-loc wird akzeptiert");
  }

  // d) Querverweis auf eine ANDERE generierte Berufsseite wird akzeptiert
  //    (das war vorher faelschlich abgelehnt, weil staticLocs allein zu eng war)
  {
    const cat = baseCatalog();
    cat.pages[0].sections = [
      { heading: "H", paragraphs: ["p"], links: [{ href: "/einstellungstest/beruf-b/", label: "Beruf B" }] },
    ];
    const errs = validate(cat);
    assert(errs.length === 0, "sections[].links.href auf eine andere generierte Berufsseite wird akzeptiert");
  }

  // e) Hub-Seite (/einstellungstest/) wird akzeptiert
  {
    const cat = baseCatalog();
    cat.pages[0].uebungen = [{ href: "/einstellungstest/", label: "Alle Berufe" }];
    const errs = validate(cat);
    assert(errs.length === 0, "uebungen.href auf die Hub-Seite /einstellungstest/ wird akzeptiert");
  }

  // f) formal gueltiger, aber unbekannter interner Pfad wird trotzdem abgelehnt
  //    (Format-Check allein reicht nicht, das Ziel muss real existieren)
  {
    const cat = baseCatalog();
    cat.pages[0].uebungen = [{ href: "/lernen/nicht-vorhanden.html", label: "L" }];
    const errs = validate(cat);
    assert(errs.length > 0, "uebungen.href auf unbekannten, aber formal gueltigen Pfad wird abgelehnt");
  }

  // g) seoTitle (SEO-Welle Punkt 3, generate-seo.mjs validate()): optionales
  //    Feld fuer <title>/og:title, max. 65 Zeichen, nicht leer. 65 Zeichen exakt
  //    sind noch gueltig, 66 nicht mehr - und ein leerer String wird trotz
  //    korrekter Laenge (0 <= 65) abgelehnt, weil er inhaltlich nichts liefert.
  {
    const cat = baseCatalog();
    cat.pages[0].seoTitle = "x".repeat(66);
    const errs = validate(cat);
    assert(errs.length > 0, "seoTitle mit 66 Zeichen wird abgelehnt");
  }
  {
    const cat = baseCatalog();
    cat.pages[0].seoTitle = "x".repeat(65);
    const errs = validate(cat);
    assert(errs.length === 0, "seoTitle mit 65 Zeichen wird akzeptiert");
  }
  {
    const cat = baseCatalog();
    cat.pages[0].seoTitle = "";
    const errs = validate(cat);
    assert(errs.length > 0, "leerer seoTitle wird abgelehnt");
  }

  // h) seoTitle-Laenge zaehlt Unicode-Codepoints, nicht UTF-16-Einheiten
  //    (String.length wuerde ein astrales Zeichen wie "𝄞" als 2 zaehlen, weil
  //    es als Surrogatpaar codiert ist - dann liesse ein zu langer Titel sich
  //    faelschlich durchschmuggeln oder ein gueltiger wuerde abgelehnt).
  {
    const cat = baseCatalog();
    cat.pages[0].seoTitle = `${"x".repeat(64)}𝄞`; // 64 ASCII + 1 astrales Zeichen = 65 Codepoints
    const errs = validate(cat);
    assert(errs.length === 0, "seoTitle mit 64 ASCII-Zeichen + 1 astralem Zeichen (65 Codepoints) wird akzeptiert");
  }
  {
    const cat = baseCatalog();
    cat.pages[0].seoTitle = `${"x".repeat(65)}𝄞`; // 65 ASCII + 1 astrales Zeichen = 66 Codepoints
    const errs = validate(cat);
    assert(errs.length > 0, "seoTitle mit 65 ASCII-Zeichen + 1 astralem Zeichen (66 Codepoints) wird abgelehnt");
  }

  console.log(failures === 0 ? "\nALLE TESTS OK" : `\n${failures} FEHLER`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => {
  console.error("FAIL: Test lief mit Fehler:", e);
  process.exit(1);
});
