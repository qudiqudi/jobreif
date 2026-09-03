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
function eq(a, b, msg) {
  assert(a === b, `${msg} (erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)})`);
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

  // --- SEO-Welle Punkt 5 (Hub als Ratgeber): cat.hub ist optional; validate()
  // muss ohne "hub" unveraendert durchlaufen UND mit "hub" dieselben Regeln wie
  // pages[].seoTitle/sections anwenden (validateSections()/validateFaq() sind
  // fuer beide Einsatzorte geteilt, siehe generate-seo.mjs). baseHub() liefert
  // einen VOLLSTAENDIGEN, gueltigen Hub (inkl. sections/faq/lastmod) - sobald
  // "hub" existiert, sind diese drei Pflicht (Codex-Review zu bc1f423: ein
  // gekuerzter Katalog darf keinen stillen Hub ohne Ratgeber/FAQ erzeugen und
  // die Sitemap darf nicht still auf updatedAt zurueckfallen).
  function baseHub() {
    return {
      title: "Hub-Titel",
      seoTitle: "Hub-SEO-Titel",
      description: "Hub-Beschreibung",
      lead: "Hub-Lead",
      sections: [
        { heading: "H1", paragraphs: ["p1"] },
        { heading: "H2", paragraphs: ["p2"] },
        { heading: "H3", paragraphs: ["p3"] },
      ],
      faq: [
        { q: "F1?", a: "A1." },
        { q: "F2?", a: "A2." },
        { q: "F3?", a: "A3." },
      ],
      lastmod: "2026-01-01",
    };
  }

  // q) Katalog ohne "hub" bleibt gueltig (additives, optionales Feld).
  {
    const cat = baseCatalog();
    assert(!("hub" in cat), "Fixtur-Voraussetzung: baseCatalog() hat kein hub");
    const errs = validate(cat);
    assert(errs.length === 0, "validate() laeuft ohne cat.hub unveraendert durch (keine hub-Fehler)");
  }

  // r) hub.seoTitle: dieselbe 65-Zeichen-Grenze (Codepoints) wie pages[].seoTitle.
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), seoTitle: "x".repeat(66) };
    const errs = validate(cat);
    assert(errs.length > 0, "hub.seoTitle mit 66 Zeichen wird abgelehnt");
  }
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), seoTitle: "x".repeat(65) };
    const errs = validate(cat);
    assert(errs.length === 0, "hub.seoTitle mit 65 Zeichen wird akzeptiert");
  }

  // s) hub.description: 155-Zeichen-Grenze (neu, nur fuer den Hub - pages[] hat
  // dafuer keine Laengenpruefung).
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), description: "x".repeat(156) };
    const errs = validate(cat);
    assert(errs.length > 0, "hub.description mit 156 Zeichen wird abgelehnt");
  }
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), description: "x".repeat(155) };
    const errs = validate(cat);
    assert(errs.length === 0, "hub.description mit 155 Zeichen wird akzeptiert");
  }

  // Zwei neutrale Fuellabschnitte, damit die t)/u)-Faelle unten trotz des neuen
  // Minimums (mind. 3 sections/faq, siehe oben) gezielt NUR das eine interessante
  // Element testen koennen, ohne selbst gegen das Minimum zu verstossen.
  const fillerSections = [
    { heading: "F1", paragraphs: ["p"] },
    { heading: "F2", paragraphs: ["p"] },
  ];
  const fillerFaq = [
    { q: "F1?", a: "A1." },
    { q: "F2?", a: "A2." },
  ];

  // t) hub.sections[].links[].href: dieselbe internalLocs-Pflicht wie bei
  // pages[].sections[].links[].href (validateSections() ist geteilt).
  {
    const cat = baseCatalog();
    cat.hub = {
      ...baseHub(),
      sections: [...fillerSections, { heading: "H", paragraphs: ["p"], links: [{ href: "/lernen/nicht-vorhanden.html", label: "L" }] }],
    };
    const errs = validate(cat);
    assert(errs.length > 0, "hub.sections[].links[].href auf unbekanntes Ziel wird abgelehnt");
  }
  {
    const cat = baseCatalog();
    cat.hub = {
      ...baseHub(),
      sections: [...fillerSections, { heading: "H", paragraphs: ["p"], links: [{ href: "/lernen/x.html", label: "L" }] }],
    };
    const errs = validate(cat);
    assert(errs.length === 0, "hub.sections[].links[].href auf bekannte staticPages-loc wird akzeptiert");
  }
  {
    const cat = baseCatalog();
    cat.hub = {
      ...baseHub(),
      sections: [...fillerSections, { heading: "H", paragraphs: ["p"], links: [{ href: "/einstellungstest/beruf-a/", label: "L" }] }],
    };
    const errs = validate(cat);
    assert(errs.length === 0, "hub.sections[].links[].href auf eine generierte Berufsseite wird akzeptiert");
  }

  // u) hub.faq: dasselbe {q, a}-Format wie pages[].faq (validateFaq() ist geteilt).
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), faq: [...fillerFaq, { q: "Frage?" }] };
    const errs = validate(cat);
    assert(errs.length > 0, "hub.faq mit fehlendem 'a' wird abgelehnt");
  }
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), faq: [...fillerFaq, { q: "Frage?", a: "Antwort." }] };
    const errs = validate(cat);
    assert(errs.length === 0, "hub.faq mit gueltigem {q, a} wird akzeptiert");
  }

  // v) hub ohne title/seoTitle/description/lead wird abgelehnt (Pflichtfelder).
  {
    const cat = baseCatalog();
    cat.hub = { title: "Nur Titel" };
    const errs = validate(cat);
    assert(errs.length > 0, "hub ohne seoTitle/description/lead wird abgelehnt");
  }

  // w) hub.sections ist Pflicht (mind. 3 Eintraege), SOBALD hub existiert -
  // sonst wuerde ein gekuerzter Katalog still einen Hub ohne Ratgeber-Inhalt
  // erzeugen (Codex-Review zu bc1f423).
  {
    const cat = baseCatalog();
    const hub = baseHub();
    delete hub.sections;
    cat.hub = hub;
    const errs = validate(cat);
    assert(errs.length > 0, "hub ohne sections wird abgelehnt (Pflichtfeld)");
  }
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), sections: [] };
    const errs = validate(cat);
    assert(errs.length > 0, "hub.sections als leeres Array wird abgelehnt");
  }
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), sections: fillerSections }; // nur 2 Eintraege
    const errs = validate(cat);
    assert(errs.length > 0, "hub.sections mit nur 2 Eintraegen wird abgelehnt (Minimum 3)");
  }

  // x) hub.faq ist Pflicht (mind. 3 Eintraege), SOBALD hub existiert - sonst
  // wuerde ein gekuerzter Katalog still einen Hub ohne FAQ erzeugen.
  {
    const cat = baseCatalog();
    const hub = baseHub();
    delete hub.faq;
    cat.hub = hub;
    const errs = validate(cat);
    assert(errs.length > 0, "hub ohne faq wird abgelehnt (Pflichtfeld)");
  }
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), faq: [] };
    const errs = validate(cat);
    assert(errs.length > 0, "hub.faq als leeres Array wird abgelehnt");
  }
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), faq: fillerFaq }; // nur 2 Eintraege
    const errs = validate(cat);
    assert(errs.length > 0, "hub.faq mit nur 2 Eintraegen wird abgelehnt (Minimum 3)");
  }

  // y) hub.lastmod ist Pflicht, SOBALD hub existiert - kein stiller Fallback
  // auf cat.updatedAt mehr in der Sitemap (renderSitemap() in generate-seo.mjs).
  {
    const cat = baseCatalog();
    const hub = baseHub();
    delete hub.lastmod;
    cat.hub = hub;
    const errs = validate(cat);
    assert(errs.length > 0, "hub ohne lastmod wird abgelehnt (Pflichtfeld)");
  }
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), lastmod: "01.01.2026" };
    const errs = validate(cat);
    assert(errs.length > 0, "hub.lastmod im falschen Format (DATE_RE) wird abgelehnt");
  }
  {
    const cat = baseCatalog();
    cat.hub = { ...baseHub(), lastmod: "" };
    const errs = validate(cat);
    assert(errs.length > 0, "hub.lastmod als leerer String wird abgelehnt");
  }

  // z) ein vollstaendiger hub (alle Pflichtfelder inkl. sections/faq/lastmod)
  // wird akzeptiert - Gegenprobe zu w)/x)/y).
  {
    const cat = baseCatalog();
    cat.hub = baseHub();
    const errs = validate(cat);
    assert(errs.length === 0, "vollstaendiger hub (inkl. sections/faq/lastmod) wird akzeptiert");
  }

  // --- SEO-Welle Punkt 4 (interne Verlinkung): Footer-Linkblock (index.html) --
  // und Berufe-Block auf den Lernseiten. Regressionsschutz fuer
  // renderFooterLinks()/renderLernenBerufe()/berufeForLernenPage() aus
  // generate-seo.mjs.
  const { renderFooterLinks, renderLernenBerufe, berufeForLernenPage, replaceBetweenMarkers } = mod;
  assert(typeof renderFooterLinks === "function", "renderFooterLinks() ist exportiert");
  assert(typeof renderLernenBerufe === "function", "renderLernenBerufe() ist exportiert");
  assert(typeof berufeForLernenPage === "function", "berufeForLernenPage() ist exportiert");
  assert(typeof replaceBetweenMarkers === "function", "replaceBetweenMarkers() ist exportiert");

  // i) renderFooterLinks(): jede Berufsseite als href, jede Lernseite mit label
  //    als href - keine Seite darf im generierten Footer-Block fehlen.
  {
    const cat = baseCatalog();
    cat.pages.push({
      slug: "beruf-c", beruf: "Beruf C", title: "Titel C", description: "Beschreibung C",
      intro: "Intro C", testTypes: ["fachwissen"], lastmod: "2026-01-01",
    });
    cat.staticPages[0].label = "Modul X";
    cat.staticPages.push({ loc: "/lernen/y.html", lastmod: "2026-01-01", label: "Modul Y" });
    cat.staticPages.push({ loc: "/lernen/ohne-label.html", lastmod: "2026-01-01" });
    const html = renderFooterLinks(cat);
    for (const p of cat.pages) {
      assert(html.includes(`href="/einstellungstest/${p.slug}/"`), `Footer-Block: href fuer Beruf "${p.slug}" vorhanden`);
    }
    assert(html.includes('href="/lernen/x.html"') && html.includes(">Modul X<"), "Footer-Block: Lernseite x.html mit label verlinkt");
    assert(html.includes('href="/lernen/y.html"') && html.includes(">Modul Y<"), "Footer-Block: Lernseite y.html mit label verlinkt");
    assert(!html.includes("ohne-label.html"), "Footer-Block: Lernseite ohne label wird NICHT verlinkt");
  }

  // j) staticPages[].berufe: unbekannter Slug wird abgelehnt, bekannte werden
  //    akzeptiert (Validierung laeuft erst NACH der pages-Verarbeitung, siehe
  //    validate()).
  {
    const cat = baseCatalog();
    cat.staticPages[0].berufe = ["beruf-a", "nicht-vorhanden"];
    const errs = validate(cat);
    assert(errs.length > 0, "staticPages.berufe mit unbekanntem Slug wird abgelehnt");
  }
  {
    const cat = baseCatalog();
    cat.staticPages[0].berufe = ["beruf-a", "beruf-b"];
    const errs = validate(cat);
    assert(errs.length === 0, "staticPages.berufe mit ausschliesslich bekannten Slugs wird akzeptiert");
  }
  {
    const cat = baseCatalog();
    cat.staticPages[0].berufe = [];
    const errs = validate(cat);
    assert(errs.length > 0, "staticPages.berufe als leeres Array wird abgelehnt");
  }
  {
    const cat = baseCatalog();
    cat.staticPages[0].label = "";
    const errs = validate(cat);
    assert(errs.length > 0, "staticPages.label als leerer String wird abgelehnt");
  }

  // k) Linktexte sind HTML-escaped - sowohl im Footer-Block als auch im
  //    Berufe-Block der Lernseiten. "beruf"/"label" landen unescaped im
  //    Katalog, esc() muss beim Rendern greifen (kein rohes "<"/"&" im Output).
  {
    const cat = baseCatalog();
    cat.pages[0].beruf = "Kaufmann <X> & Co";
    cat.staticPages[0].label = "A & <b>B</b>";
    const footerHtml = renderFooterLinks(cat);
    assert(footerHtml.includes("Kaufmann &lt;X&gt; &amp; Co"), "Footer-Block: Beruf-Linktext ist HTML-escaped");
    assert(footerHtml.includes("A &amp; &lt;b&gt;B&lt;/b&gt;"), "Footer-Block: Lernseiten-Linktext (label) ist HTML-escaped");
    assert(!footerHtml.includes("<X>") && !footerHtml.includes("<b>B</b>"), "Footer-Block: kein rohes HTML aus beruf/label im Output");
  }
  {
    const cat = baseCatalog();
    cat.pages[0].beruf = "Kaufmann <X> & Co";
    cat.staticPages[0].berufe = ["beruf-a"];
    const berufeHtml = renderLernenBerufe(cat.staticPages[0], cat);
    assert(berufeHtml.includes("Kaufmann &lt;X&gt; &amp; Co"), "Lernseiten-Berufe-Block: Beruf-Linktext ist HTML-escaped");
    assert(!berufeHtml.includes("<X>"), "Lernseiten-Berufe-Block: kein rohes HTML aus beruf im Output");
  }

  // l) berufeForLernenPage(): (a) explizites berufe hat Vorrang vor (b) der
  //    LERNEN-Herleitung, und (b) dedupliziert + deckelt auf maximal 8, in
  //    Katalogreihenfolge.
  {
    const cat = baseCatalog();
    cat.staticPages[0].berufe = ["beruf-b"]; // (a): nur beruf-b, obwohl beide testTypes=fachwissen tragen
    const berufe = berufeForLernenPage(cat.staticPages[0], cat);
    assert(berufe.length === 1 && berufe[0].slug === "beruf-b", "berufeForLernenPage: explizites berufe hat Vorrang");
  }
  {
    // (b): LERNEN-Herleitung ueber testTypes - loc muss exakt einem LERNEN-Wert
    // entsprechen (hier /lernen/zahlenreihen.html), sonst greift (b) gar nicht.
    const cat = {
      version: 1,
      baseUrl: "https://example.test",
      updatedAt: "2026-01-01",
      staticPages: [{ loc: "/lernen/zahlenreihen.html", lastmod: "2026-01-01", label: "Zahlenreihen" }],
      testTypes: { zahlenreihe: { label: "Zahlenreihen", description: "Testet Zahlenreihen." } },
      pages: Array.from({ length: 10 }, (_, i) => ({
        slug: `beruf-${i}`, beruf: `Beruf ${i}`, title: `T${i}`, description: `D${i}`,
        intro: `I${i}`, testTypes: ["zahlenreihe"], lastmod: "2026-01-01",
      })),
    };
    assert(validate(cat).length === 0, "l) synthetischer LERNEN-Katalog (10 Berufe, alle zahlenreihe) ist gueltig");
    const berufe = berufeForLernenPage(cat.staticPages[0], cat);
    eq(berufe.length, 8, "berufeForLernenPage: hergeleitete Liste (10 Treffer) wird auf 8 gedeckelt");
    eq(berufe[0].slug, "beruf-0", "berufeForLernenPage: hergeleitete Liste bleibt in Katalogreihenfolge");
    eq(berufe[7].slug, "beruf-7", "berufeForLernenPage: gedeckelte Liste endet beim 8. Katalogeintrag");
    const html = renderLernenBerufe(cat.staticPages[0], cat);
    const cardCount = (html.match(/class="card"/g) || []).length;
    eq(cardCount, 8, "renderLernenBerufe: rendert genau 8 Karten (gedeckelt)");
  }

  // m) replaceBetweenMarkers(): Start- und End-Marker muessen je GENAU einmal
  //    vorkommen, in der richtigen Reihenfolge - sonst wirft die Funktion.
  //    Codex-Review zu f790d80: ein versehentlich doppelter Start-Marker
  //    haette sonst beim naechsten Lauf handgepflegtes HTML geloescht (nur
  //    das ERSTE indexOf-Ergebnis zaehlte), und der Drift-Check haette das
  //    Ergebnis danach faelschlich als korrekt durchgehen lassen.
  {
    const START = "<!-- s:start -->";
    const END = "<!-- s:end -->";
    const cases = [
      ["fehlender Start-Marker", `PRAEFIX${END}SUFFIX`],
      ["fehlender End-Marker", `PRAEFIX${START}SUFFIX`],
      ["doppelter Start-Marker", `PRAEFIX${START}x${START}y${END}SUFFIX`],
      ["doppelter End-Marker", `PRAEFIX${START}x${END}y${END}SUFFIX`],
      ["vertauschte Reihenfolge (Ende vor Start)", `PRAEFIX${END}x${START}SUFFIX`],
    ];
    for (const [label, text] of cases) {
      let threw = false;
      try {
        replaceBetweenMarkers(text, START, END, "INNER", "fixture.html");
      } catch (e) {
        threw = true;
      }
      assert(threw, `replaceBetweenMarkers: ${label} wirft`);
    }
  }

  // n) Praefix vor dem Start- und Suffix nach dem End-Marker bleiben byte-
  //    identisch (Sentinel-Strings inkl. Sonderzeichen und Zeilenumbruechen),
  //    und NUR der Inhalt zwischen den Markern wird ersetzt.
  {
    const START = "<!-- s:start -->";
    const END = "<!-- s:end -->";
    const prefix = 'PRAEFIX <ä&ö"ü> Zeile1\nZeile2   ';
    const suffix = '   Zeile3\nZeile4 <ß&ü"ä> SUFFIX';
    const text = `${prefix}${START}ALT-INHALT${END}${suffix}`;
    const out = replaceBetweenMarkers(text, START, END, "NEU-INHALT", "fixture.html");
    assert(out.startsWith(prefix), "replaceBetweenMarkers: Praefix vor dem Start-Marker bleibt byte-identisch");
    assert(out.endsWith(suffix), "replaceBetweenMarkers: Suffix nach dem End-Marker bleibt byte-identisch");
    assert(out.includes("NEU-INHALT") && !out.includes("ALT-INHALT"), "replaceBetweenMarkers: Inhalt zwischen den Markern wird ersetzt");
  }

  // o) Idempotenz: zweimalige Anwendung mit demselben inner liefert dasselbe
  //    Ergebnis - genau das, was der Generator bei wiederholtem Lauf tut
  //    (Drift-Check erwartet ein stabiles Fixpunkt-Ergebnis).
  {
    const START = "<!-- s:start -->";
    const END = "<!-- s:end -->";
    const text = `A${START}alt${END}B`;
    const once = replaceBetweenMarkers(text, START, END, "X", "fixture.html");
    const twice = replaceBetweenMarkers(once, START, END, "X", "fixture.html");
    eq(twice, once, "replaceBetweenMarkers: zweimalige Anwendung mit gleichem inner ist idempotent");
  }

  // p) CRLF-Eingabe: Zeilenenden AUSSERHALB des Marker-Blocks bleiben CRLF -
  //    replaceBetweenMarkers normalisiert nicht auf LF, "before"/"after" sind
  //    rohe Teilstrings des Originals.
  {
    const START = "<!-- s:start -->";
    const END = "<!-- s:end -->";
    const text = `Zeile1\r\nZeile2\r\n${START}alt${END}\r\nZeile3\r\n`;
    const out = replaceBetweenMarkers(text, START, END, "X", "fixture.html");
    assert(out.startsWith("Zeile1\r\nZeile2\r\n"), "replaceBetweenMarkers: CRLF vor dem Start-Marker bleibt erhalten");
    assert(out.endsWith("\r\nZeile3\r\n"), "replaceBetweenMarkers: CRLF nach dem End-Marker bleibt erhalten");
  }

  console.log(failures === 0 ? "\nALLE TESTS OK" : `\n${failures} FEHLER`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => {
  console.error("FAIL: Test lief mit Fehler:", e);
  process.exit(1);
});
