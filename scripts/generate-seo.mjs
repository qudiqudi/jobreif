#!/usr/bin/env node
// SEO-Generator (Plan 2026, 3.7b / Abschnitt 6) — dependency-frei.
//
// Liest seo/catalog.json, validiert minimal und schreibt pro Eintrag eine
// statische Landingpage `einstellungstest/<slug>/index.html` sowie eine
// komplett neu erzeugte `sitemap.xml` (Root + alle SEO-URLs). Kein Bundler,
// keine Templates, kein Laufzeit-Build: HTML wird selbst escaped und als
// String zusammengesetzt. Output wird committet.
//
// WICHTIG (Plan 3.7b):
//   - Die erzeugten Seiten gehoeren NICHT in die `sw.js` ASSETS-Precache-Liste.
//     Network-first cacht same-origin GETs ohnehin; ein Precache wuerde mit
//     jedem Katalogwachstum aufblaehen.
//   - Personalisierte/echte Testgenerierung passiert erst on-demand in der App
//     (per Klick, ueber Gratis-Kontingent/Credits gegated). Diese Seiten sind
//     statischer Einstieg + Beispielaufgaben, KEINE vorgerenderte Personalisierung.
//
// Nutzung:  node scripts/generate-seo.mjs   (vom Repo-Root oder via npm-Skript)

import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const catalogPath = path.join(root, "seo", "catalog.json");
const outDir = path.join(root, "einstellungstest");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Interner Link (uebungen.href, sections[].links[].href): GENAU ein fuehrender
// Slash, danach nur unbedenkliche Pfadzeichen - kein zweiter Slash direkt danach
// (das waere ein protokollrelativer Verweis wie "//evil.example/x", den Browser
// als absolute URL zu einem fremden Host auffassen), kein Backslash, kein "?"
// oder "#" (Query/Fragment koennten sonst einen an sich bekannten Pfad zu einem
// unerwarteten Ziel umbiegen). startsWith("/") allein liesse all das durch.
const INTERNAL_HREF_RE = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

// Mapping testType -> vertiefende Lernseite (/lernen/). Verlinkt die Berufsseiten
// mit den vorhandenen Modul-Erklaerseiten (interne Vernetzung + Discovery der
// bislang schwach verlinkten /lernen/-Seiten). fachwissen hat keine Lernseite.
const LERNEN = {
  zahlenreihe: "/lernen/zahlenreihen.html",
  sprachlogik: "/lernen/sprachlogik.html",
  konzentration: "/lernen/konzentration.html",
  figural: "/lernen/figuren-matrizen.html",
};
const MAX_RELATED = 6;
// SEO-Welle Punkt 4 (interne Verlinkung): maximale Anzahl automatisch aus LERNEN
// hergeleiteter Berufe auf einer Lernseite (siehe berufeForLernenPage() unten).
// Gilt NUR fuer die hergeleitete Variante - ein handgepflegtes staticPages[].berufe
// ist eine Redaktionsentscheidung und wird nicht gekappt.
const MAX_LERNEN_BERUFE = 8;

// Amtspruefungs-Berufe: standardisierter Behoerdentest statt einzelner Stellenanzeige.
// Die App zeigt fuer sie im Gast-Einstieg einen anderen Kontext-Hinweis (art=pruefung).
const EXAM_SLUGS = new Set(["polizei", "zoll"]);

// Marker, zwischen denen der Generator generierte Linkbloecke in handgepflegten
// Seiten (index.html, lernen/*.html) einsetzt. Alles AUSSERHALB der Marker bleibt
// unangetastet; fehlen die Marker, bricht der Lauf mit klarer Fehlermeldung ab
// (siehe replaceBetweenMarkers()), statt still nichts zu tun.
const MARK_LINKS_START = "<!-- seo-links:start -->";
const MARK_LINKS_END = "<!-- seo-links:end -->";
const MARK_BERUFE_START = "<!-- seo-berufe:start -->";
const MARK_BERUFE_END = "<!-- seo-berufe:end -->";

// --- HTML/XML-Escaping (selbst, ohne Abhaengigkeit) -------------------------
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
// JSON-LD sicher in ein <script>-Tag einbetten: nur das schliessende Tag /
// die <-Sequenz neutralisieren, sonst bleibt es valides JSON.
function jsonLd(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

// --- Validierung ------------------------------------------------------------
function validate(cat) {
  const errs = [];
  const fail = (m) => errs.push(m);

  if (!cat || typeof cat !== "object" || Array.isArray(cat)) {
    return ["catalog: kein Objekt"];
  }
  if (!Number.isInteger(cat.version) || cat.version < 1) fail("version: positive Ganzzahl erwartet");
  if (typeof cat.baseUrl !== "string" || !/^https:\/\/[^/]+$/.test(cat.baseUrl)) {
    fail('baseUrl: erwartet "https://host" ohne abschliessenden Slash');
  }
  if (typeof cat.updatedAt !== "string" || !DATE_RE.test(cat.updatedAt)) fail("updatedAt: YYYY-MM-DD erwartet");

  // staticPages: handgepflegte Seiten (z. B. /lernen/), die NICHT vom Generator
  // erzeugt werden, aber in der Sitemap stehen muessen (sonst fallen sie raus).
  // label/berufe (SEO-Welle Punkt 4, interne Verlinkung): optional, additiv.
  // label ist der Kurzname fuer Linktexte (Footer-Block auf index.html); berufe
  // sind die passenden Berufsseiten-Slugs fuer den Block auf der Lernseite
  // selbst. berufe[].Slug-Existenz kann erst geprueft werden, wenn cat.pages
  // bekannt ist - das passiert weiter unten, NACH der pages-Validierung.
  if (cat.staticPages != null) {
    if (!Array.isArray(cat.staticPages)) fail("staticPages: Array erwartet");
    else cat.staticPages.forEach((s, i) => {
      if (!s || typeof s.loc !== "string" || !s.loc.startsWith("/")) fail(`staticPages[${i}].loc: muss mit "/" beginnen`);
      if (typeof s.lastmod !== "string" || !DATE_RE.test(s.lastmod)) fail(`staticPages[${i}].lastmod: YYYY-MM-DD erwartet`);
      if (s && s.label != null && (typeof s.label !== "string" || !s.label.trim())) {
        fail(`staticPages[${i}].label: nicht-leerer String erwartet`);
      }
      if (s && s.berufe != null) {
        if (!Array.isArray(s.berufe) || s.berufe.length === 0) {
          fail(`staticPages[${i}].berufe: nicht-leeres Array erwartet`);
        } else {
          s.berufe.forEach((slug, j) => {
            if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
              fail(`staticPages[${i}].berufe[${j}]: Slug-foermiger String erwartet`);
            }
          });
        }
      }
    });
  }

  const types = cat.testTypes;
  if (!types || typeof types !== "object" || Array.isArray(types)) {
    fail("testTypes: Objekt {key: {label, description}} erwartet");
  } else {
    for (const [k, v] of Object.entries(types)) {
      if (!SLUG_RE.test(k)) fail(`testTypes.${k}: Key muss slug-foermig sein`);
      if (!v || typeof v.label !== "string" || !v.label) fail(`testTypes.${k}.label fehlt`);
      if (!v || typeof v.description !== "string" || !v.description) fail(`testTypes.${k}.description fehlt`);
    }
  }
  const knownType = (t) => !!types && Object.prototype.hasOwnProperty.call(types, t);

  // Bekannte staticPages-locs (fuer die uebungen-/links-Validierung unten): ein
  // interner Link darf nur auf eine Seite zeigen, die tatsaechlich in der
  // Sitemap landet.
  const staticLocs = new Set(
    Array.isArray(cat.staticPages) ? cat.staticPages.map((s) => s && s.loc).filter(Boolean) : []
  );

  if (!Array.isArray(cat.pages) || cat.pages.length === 0) {
    fail("pages: nicht-leeres Array erwartet");
    return errs;
  }

  // Kanonische Menge ALLER gueltigen internen Ziele: die handgepflegten
  // staticPages PLUS die vom Generator selbst erzeugten Seiten (Hub +
  // /einstellungstest/<slug>/ je gueltigem Slug). Ohne die generierten Seiten
  // hier waere jeder Querverweis auf eine andere Berufsseite faelschlich
  // abgelehnt worden.
  const internalLocs = new Set(staticLocs);
  internalLocs.add("/einstellungstest/");
  cat.pages.forEach((p) => {
    if (p && typeof p.slug === "string" && SLUG_RE.test(p.slug)) {
      internalLocs.add(`/einstellungstest/${p.slug}/`);
    }
  });

  const seen = new Set();
  cat.pages.forEach((p, i) => {
    const at = (m) => fail(`pages[${i}]${p && p.slug ? ` (${p.slug})` : ""}: ${m}`);
    if (!p || typeof p !== "object") return at("kein Objekt");
    if (typeof p.slug !== "string" || !SLUG_RE.test(p.slug)) at("slug fehlt/ungueltig (a-z0-9, mit Bindestrichen)");
    else if (seen.has(p.slug)) at("slug doppelt"); else seen.add(p.slug);
    for (const f of ["beruf", "title", "description", "intro"]) {
      if (typeof p[f] !== "string" || !p[f].trim()) at(`${f} fehlt/leer`);
    }
    // seoTitle: optionales, additives Feld (Plan 2026, SEO-Welle Punkt 3). Ersetzt
    // NUR <title>/og:title durch eine klickstaerkere Variante (z. B. mit "kostenlos"/
    // "Loesungen"); die <h1> bleibt IMMER "title" (siehe renderPage()). Max. 65
    // Zeichen, weil Suchmaschinen laengere Titel im Suchergebnis abschneiden - ein
    // abgeschnittener Titel waere fuer die Klickrate kontraproduktiv.
    if (p.seoTitle != null) {
      if (typeof p.seoTitle !== "string" || !p.seoTitle.trim()) at("seoTitle: nicht-leerer String erwartet");
      else {
        // Codepoints zaehlen, nicht UTF-16-Einheiten (String.length): astrale
        // Zeichen (z. B. Emoji) bestehen aus einem Surrogatpaar und wuerden sonst
        // doppelt gezaehlt - [...str] iteriert ueber Codepoints.
        const len = [...p.seoTitle].length;
        if (len > 65) at(`seoTitle: max. 65 Zeichen erwartet (war ${len})`);
      }
    }
    if (!Array.isArray(p.testTypes) || p.testTypes.length === 0) at("testTypes: nicht-leeres Array");
    else p.testTypes.forEach((t) => { if (!knownType(t)) at(`testTypes-Eintrag "${t}" nicht in catalog.testTypes`); });
    if (p.samples != null) {
      if (!Array.isArray(p.samples)) at("samples: Array erwartet");
      else p.samples.forEach((s, j) => {
        if (!s || typeof s !== "object") return at(`samples[${j}]: kein Objekt`);
        if (!knownType(s.type)) at(`samples[${j}].type "${s.type}" unbekannt`);
        if (typeof s.question !== "string" || !s.question.trim()) at(`samples[${j}].question fehlt`);
        if (typeof s.answer !== "string" || !s.answer.trim()) at(`samples[${j}].answer fehlt`);
        if (s.options != null && (!Array.isArray(s.options) || s.options.some((o) => typeof o !== "string"))) {
          at(`samples[${j}].options: String-Array erwartet`);
        }
      });
    }
    if (p.faq != null) {
      if (!Array.isArray(p.faq)) at("faq: Array erwartet");
      else p.faq.forEach((q, j) => {
        if (!q || typeof q.q !== "string" || !q.q.trim() || typeof q.a !== "string" || !q.a.trim()) {
          at(`faq[${j}]: {q, a} als nicht-leere Strings erwartet`);
        }
      });
    }
    // uebungen: optionales, additives Feld - verlinkt passende Gratis-Uebungsmodule (/lernen/)
    // unter "Diese Testarten uebst du hier". href MUSS ein bekanntes internes Ziel sein
    // (staticPages ODER eine generierte Berufsseite, siehe internalLocs oben) UND dem
    // INTERNAL_HREF_RE-Muster entsprechen (kein "//host", kein Backslash, kein "?"/"#") -
    // sonst entstuende ein interner Link auf eine Seite, die die Sitemap gar nicht kennt,
    // oder schlimmer: ein Link, den der Browser als externe/absolute URL auffasst.
    if (p.uebungen != null) {
      if (!Array.isArray(p.uebungen)) at("uebungen: Array erwartet");
      else p.uebungen.forEach((u, j) => {
        if (!u || typeof u !== "object") return at(`uebungen[${j}]: kein Objekt`);
        if (typeof u.href !== "string" || !INTERNAL_HREF_RE.test(u.href)) {
          at(`uebungen[${j}].href: muss ein interner Pfad ohne "//", Backslash, Query oder Fragment sein`);
        } else if (!internalLocs.has(u.href)) at(`uebungen[${j}].href "${u.href}" nicht in staticPages/pages`);
        if (typeof u.label !== "string" || !u.label.trim()) at(`uebungen[${j}].label fehlt/leer`);
      });
    }
    // sections: optionales, additives Feld fuer vertiefende Inhaltsabschnitte (Plan 2026,
    // SEO-Welle Punkt 2). Rendert zwischen "Beispielaufgaben" und "So bereitest du dich vor".
    // items/examples/links sind je Abschnitt optional; examples nutzt dasselbe Frage-/Antwort-
    // Markup wie die Beispielaufgaben (Details/"Loesung anzeigen"), links denselben Stil wie
    // das uebungen-Feld. links.href gilt derselben internalLocs-Pflicht wie uebungen.href.
    if (p.sections != null) {
      if (!Array.isArray(p.sections)) at("sections: Array erwartet");
      else p.sections.forEach((sec, j) => {
        if (!sec || typeof sec !== "object") return at(`sections[${j}]: kein Objekt`);
        if (typeof sec.heading !== "string" || !sec.heading.trim()) at(`sections[${j}].heading fehlt/leer`);
        if (!Array.isArray(sec.paragraphs) || sec.paragraphs.length === 0
          || sec.paragraphs.some((t) => typeof t !== "string" || !t.trim())) {
          at(`sections[${j}].paragraphs: nicht-leeres String-Array erwartet`);
        }
        if (sec.items != null) {
          if (!Array.isArray(sec.items) || sec.items.some((t) => typeof t !== "string" || !t.trim())) {
            at(`sections[${j}].items: String-Array erwartet`);
          }
        }
        if (sec.examples != null) {
          if (!Array.isArray(sec.examples)) at(`sections[${j}].examples: Array erwartet`);
          else sec.examples.forEach((ex, k) => {
            if (!ex || typeof ex.q !== "string" || !ex.q.trim() || typeof ex.a !== "string" || !ex.a.trim()) {
              at(`sections[${j}].examples[${k}]: {q, a} als nicht-leere Strings erwartet`);
            }
          });
        }
        if (sec.links != null) {
          if (!Array.isArray(sec.links)) at(`sections[${j}].links: Array erwartet`);
          else sec.links.forEach((l, k) => {
            if (!l || typeof l !== "object") return at(`sections[${j}].links[${k}]: kein Objekt`);
            if (typeof l.href !== "string" || !INTERNAL_HREF_RE.test(l.href)) {
              at(`sections[${j}].links[${k}].href: muss ein interner Pfad ohne "//", Backslash, Query oder Fragment sein`);
            } else if (!internalLocs.has(l.href)) at(`sections[${j}].links[${k}].href "${l.href}" nicht in staticPages/pages`);
            if (typeof l.label !== "string" || !l.label.trim()) at(`sections[${j}].links[${k}].label fehlt/leer`);
          });
        }
      });
    }
    if (typeof p.lastmod !== "string" || !DATE_RE.test(p.lastmod)) at("lastmod: YYYY-MM-DD erwartet");
  });

  // staticPages[].berufe: jeder Slug muss ein tatsaechlich vorhandener Beruf sein
  // (erst jetzt pruefbar, "seen" enthaelt alle gueltigen, doppelfreien Slugs aus
  // der pages-Validierung oben).
  if (Array.isArray(cat.staticPages)) {
    cat.staticPages.forEach((s, i) => {
      if (!s || !Array.isArray(s.berufe)) return;
      s.berufe.forEach((slug, j) => {
        if (typeof slug === "string" && SLUG_RE.test(slug) && !seen.has(slug)) {
          fail(`staticPages[${i}].berufe[${j}] "${slug}" ist kein bekannter Beruf-Slug aus pages`);
        }
      });
    });
  }

  return errs;
}

// --- Geteilte Bausteine (F10: Berufseite + Hub nur einmal pflegen) ----------
// F6: strikte CSP fuer die statischen SEO-Seiten. Diese Seiten nutzen nur
// inline <style> (daher style-src 'unsafe-inline') und inline JSON-LD
// (application/ld+json ist ein Datenblock, wird NICHT ausgefuehrt — script-src
// 'self' blockt es nicht). Es gibt KEIN ausfuehrbares inline-<script>.
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'">`;

// Gemeinsame Basis-Styles. Enthaelt @font-face fuer Sora (F8, exakt wie
// /lernen/lernen.css), damit beide Seitentypen die Markenschrift laden statt
// nur den System-Fallback. Seiten-spezifische Regeln bleiben inline.
const BASE_CSS = `    :root{--primary:#c5543a;--primary-dark:#a8442e;--bg:#fbf7f2;--card:#fff;--text:#3a322e;--muted:#7a6f68;--border:#e7ddd3;--radius:14px}
    *{box-sizing:border-box}
    html{-webkit-text-size-adjust:100%}
    @font-face{font-family:"Sora";src:url("/assets/fonts/Sora-variable.ttf") format("truetype");font-weight:400 800;font-display:swap}
    body{margin:0;font-family:"Sora",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--bg);line-height:1.6}
    a{color:var(--primary-dark)}
    header.site{background:var(--primary);color:#fff;padding:14px 20px}
    header.site a{color:#fff;text-decoration:none;font-weight:700;font-size:1.1rem}
    main{max-width:760px;margin:0 auto;padding:28px 20px 56px}
    nav.crumbs{font-size:.82rem;color:var(--muted);margin:4px 0 18px}
    nav.crumbs a{color:var(--muted)}
    h1{font-size:1.7rem;line-height:1.25;margin:.2em 0 .4em;color:#2c2521}
    .lead{font-size:1.08rem;color:#4a413c}
    footer{max-width:760px;margin:0 auto;padding:24px 20px 48px;font-size:.84rem;color:var(--muted);border-top:1px solid var(--border)}
    footer a{color:var(--muted)}
    @media(max-width:600px){h1{font-size:1.4rem}main{padding:20px 16px 44px}}`;

// Identische Kopf-/Fusszeile beider Seitentypen.
const HEADER = `  <header class="site"><a href="/">jobreif.de</a></header>`;
const FOOTER = `  <footer>
    <p>jobreif.de macht aus jeder Stellenanzeige einen simulierten Einstellungstest mit KI-Feedback. Deine Daten bleiben in deinem Browser. <a href="/">Zur App</a></p>
  </footer>`;

// --- Seitenbau --------------------------------------------------------------
function renderSample(s, types) {
  const label = esc((types[s.type] && types[s.type].label) || s.type);
  const opts = Array.isArray(s.options) && s.options.length
    ? `<ul class="opts">${s.options.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>`
    : "";
  // Optionale Meta-Zeile (z. B. bei Fachwissen-Beispielen die ehrliche Rahmung,
  // dass die echte Frage aus der eingefuegten Stellenanzeige abgeleitet wird).
  const note = typeof s.note === "string" && s.note.trim()
    ? `\n        <p class="sample-note">${esc(s.note)}</p>` : "";
  return `<li class="sample">
        <div class="sample-type">${label}</div>${note}
        <p class="sample-q">${esc(s.question)}</p>
        ${opts}
        <details class="sample-a"><summary>Lösung anzeigen</summary><p>${esc(s.answer)}</p></details>
      </li>`;
}

// Rechenbeispiel innerhalb eines "sections"-Abschnitts (z. B. Mathe-Aufgaben).
// Nutzt bewusst dieselbe ul.samples/li.sample/details.sample-a-Struktur wie
// renderSample() oben, damit exakt dasselbe CSS greift und keine neuen Regeln
// noetig sind - nur ohne den Testarten-Badge, da diese Beispiele nicht an
// eine der App-Testarten (fachwissen/sprachlogik/...) gebunden sind.
function renderSectionExample(ex) {
  return `<li class="sample">
        <p class="sample-q">${esc(ex.q)}</p>
        <details class="sample-a"><summary>Lösung anzeigen</summary><p>${esc(ex.a)}</p></details>
      </li>`;
}

// Vertiefender Inhaltsabschnitt (optional, additiv, siehe validate()). Rendert
// als eigenes <section class="block"> zwischen Beispielaufgaben und Tipps.
// items nutzt dieselbe ul.tipps-Optik wie die Vorbereitungs-Tipps weiter unten,
// links dieselbe .uebungen-hinweis-Optik wie das uebungen-Feld - beides
// bewusst wiederverwendet statt neuem CSS.
function renderSection(sec) {
  const paras = sec.paragraphs.map((t) => `<p>${esc(t)}</p>`).join("\n        ");
  const items = Array.isArray(sec.items) ? sec.items : [];
  const itemsHtml = items.length
    ? `<ul class="tipps">
        ${items.map((x) => `<li>${esc(x)}</li>`).join("\n        ")}
        </ul>`
    : "";
  const examples = Array.isArray(sec.examples) ? sec.examples : [];
  const examplesHtml = examples.length
    ? `<ul class="samples">
        ${examples.map(renderSectionExample).join("\n        ")}
        </ul>`
    : "";
  const links = Array.isArray(sec.links) ? sec.links : [];
  const linksHtml = links.length
    ? `<p class="uebungen-hinweis">${links.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join(" · ")}</p>`
    : "";
  return `<section class="block">
        <h2>${esc(sec.heading)}</h2>
        ${paras}
        ${itemsHtml}
        ${examplesHtml}
        ${linksHtml}
      </section>`;
}

function renderPage(p, cat, idx) {
  const { baseUrl, testTypes } = cat;
  const url = `${baseUrl}/einstellungstest/${p.slug}/`;
  const samples = Array.isArray(p.samples) ? p.samples : [];
  const faq = Array.isArray(p.faq) ? p.faq : [];
  // seoTitle (optional): nur <title>/og:title, siehe validate(). Die <h1> unten
  // nutzt weiterhin ausschliesslich p.title - NIE seoTitle.
  const pageTitle = typeof p.seoTitle === "string" && p.seoTitle.trim() ? p.seoTitle : p.title;

  const typeList = p.testTypes.map((t) => {
    const def = testTypes[t];
    const label = LERNEN[t]
      ? `<a href="${LERNEN[t]}"><strong>${esc(def.label)}</strong></a>`
      : `<strong>${esc(def.label)}</strong>`;
    return `<li>${label} — ${esc(def.description)}</li>`;
  }).join("\n        ");

  // Passende Gratis-Uebungsmodule (optional, additiv) — kleiner Abschnitt direkt unter der
  // Testarten-Liste, verlinkt gezielt auf /lernen/-Seiten mit besonderer Relevanz fuer diesen
  // Beruf (z. B. Kaufmaennisches Rechnen bei kaufmaennischen Berufen).
  const uebungen = Array.isArray(p.uebungen) ? p.uebungen : [];
  const uebungenHtml = uebungen.length
    ? `<p class="uebungen-hinweis">Passende Übungsmodule: ${uebungen
        .map((u) => `<a href="${esc(u.href)}">${esc(u.label)}</a>`)
        .join(" · ")}</p>`
    : "";

  // Vorbereitungs-Tipps (optional, beruf-spezifisch) — echter Zusatzinhalt.
  const tipps = Array.isArray(p.tipps) ? p.tipps.filter((x) => typeof x === "string" && x.trim()) : [];
  const tippsHtml = tipps.length
    ? `<section class="block">
        <h2>So bereitest du dich vor</h2>
        <ul class="tipps">
        ${tipps.map((x) => `<li>${esc(x)}</li>`).join("\n        ")}
        </ul>
      </section>`
    : "";

  // Verwandte Berufe (interne Vernetzung) — umlaufendes Fenster ab dem eigenen
  // Katalog-Index, damit jede Seite gleich viele eingehende Links bekommt
  // (deterministisch; kein Zufall, sonst schluege der CI-Drift-Check an).
  const n = cat.pages.length;
  const count = Math.min(MAX_RELATED, n - 1);
  const related = Array.from({ length: count }, (_, k) => cat.pages[(idx + 1 + k) % n]);
  const relatedHtml = related.length
    ? `<section class="block">
        <h2>Einstellungstest für andere Berufe</h2>
        <ul class="related">
        ${related.map((q) => `<li><a href="/einstellungstest/${esc(q.slug)}/">Einstellungstest ${esc(q.beruf)}</a></li>`).join("\n        ")}
        </ul>
      </section>`
    : "";

  const samplesHtml = samples.length
    ? `<section class="block">
        <h2>Beispielaufgaben</h2>
        <ul class="samples">
        ${samples.map((s) => renderSample(s, testTypes)).join("\n        ")}
        </ul>
      </section>`
    : "";

  // Vertiefende Inhaltsabschnitte (optional, additiv) - zwischen Beispielaufgaben
  // und Vorbereitungs-Tipps, siehe renderSection(). sectionsBlock traegt seine
  // eigene Einrueckung/Leerzeile; ist sections leer, bleibt sectionsBlock ein
  // leerer String, damit sich am Output von Seiten ohne "sections" NICHTS
  // aendert (kein zusaetzlicher Whitespace zwischen Beispielaufgaben und Tipps).
  const sections = Array.isArray(p.sections) ? p.sections : [];
  const sectionsHtml = sections.length
    ? sections.map(renderSection).join("\n\n    ")
    : "";
  const sectionsBlock = sectionsHtml ? `\n\n    ${sectionsHtml}` : "";

  const faqHtml = faq.length
    ? `<section class="block">
        <h2>Häufige Fragen</h2>
        ${faq.map((q) => `<details class="faq"><summary>${esc(q.q)}</summary><p>${esc(q.a)}</p></details>`).join("\n        ")}
      </section>`
    : "";

  // JSON-LD: BreadcrumbList + (falls FAQ vorhanden) FAQPage.
  const ld = [{
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Start", item: `${baseUrl}/` },
      { "@type": "ListItem", position: 2, name: "Einstellungstest", item: `${baseUrl}/einstellungstest/` },
      { "@type": "ListItem", position: 3, name: p.beruf, item: url },
    ],
  }];
  if (faq.length) {
    ld.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((q) => ({
        "@type": "Question", name: q.q,
        acceptedAnswer: { "@type": "Answer", text: q.a },
      })),
    });
  }
  const ldHtml = ld.map((o) => `<script type="application/ld+json">${jsonLd(o)}</script>`).join("\n  ");

  const kind = EXAM_SLUGS.has(p.slug) ? "pruefung" : "stelle";
  const ctaUrl = `${baseUrl}/?ref=einstellungstest-${p.slug}&stelle=${encodeURIComponent(p.beruf)}&art=${kind}`;

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${CSP}
  <title>${esc(pageTitle)}</title>
  <meta name="description" content="${esc(p.description)}">
  <link rel="canonical" href="${url}">
  <meta name="robots" content="index, follow">
  <meta name="theme-color" content="#c5543a">
  <link rel="icon" href="/assets/icons/favicon-32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="jobreif.de">
  <meta property="og:locale" content="de_DE">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${esc(pageTitle)}">
  <meta property="og:description" content="${esc(p.description)}">
  <meta property="og:image" content="${baseUrl}/assets/social-preview.png">
  ${ldHtml}
  <style>
${BASE_CSS}
    h2{font-size:1.25rem;margin:1.6em 0 .5em;color:#2c2521}
    .block{margin-top:8px}
    ul.types,ul.samples{list-style:none;padding:0;margin:0}
    ul.types li{padding:10px 0;border-bottom:1px solid var(--border)}
    .uebungen-hinweis{margin:10px 0 0;font-size:.9rem;color:var(--muted)}
    .uebungen-hinweis a{font-weight:600}
    ul.tipps{margin:.4em 0;padding-left:1.2em}
    ul.tipps li{padding:4px 0}
    ul.related{list-style:none;padding:0;margin:8px 0}
    ul.related li{padding:8px 0;border-bottom:1px solid var(--border)}
    ul.related a{font-weight:600}
    .samples li.sample{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin:12px 0;box-shadow:0 2px 8px -5px rgba(80,50,40,.25)}
    .sample-type{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--primary-dark);background:#f6e7e1;border-radius:999px;padding:3px 10px;margin-bottom:8px}
    .sample-note{font-size:.74rem;color:var(--muted);margin:.1em 0 .5em;font-style:italic}
    .sample-q{font-weight:600;margin:.2em 0}
    ul.opts{margin:.4em 0 .2em;padding-left:1.2em}
    ul.opts li{padding:2px 0}
    details{margin:.4em 0}
    details summary{cursor:pointer;font-weight:600;color:var(--primary-dark)}
    details.faq{border-bottom:1px solid var(--border);padding:10px 0}
    details.faq summary{font-weight:600;color:#2c2521}
    .cta{display:block;text-align:center;margin:28px 0 8px;background:var(--primary);color:#fff;text-decoration:none;font-weight:700;padding:16px 22px;border-radius:var(--radius);box-shadow:0 10px 24px -12px rgba(197,84,58,.7)}
    .cta:hover{background:var(--primary-dark)}
    .cta-note{text-align:center;font-size:.84rem;color:var(--muted);margin:0}
  </style>
</head>
<body>
${HEADER}
  <main>
    <nav class="crumbs"><a href="/">Start</a> › <a href="/einstellungstest/">Einstellungstest</a> › ${esc(p.beruf)}</nav>
    <h1>${esc(p.title)}</h1>
    <p class="lead">${esc(p.intro)}</p>

    <a class="cta" href="${esc(ctaUrl)}">Jetzt kostenlos üben →</a>
    <p class="cta-note">Aus echter Stellenanzeige · KI-Feedback · ohne Installation. Allgemeine Übungsmodule sofort ohne Anmeldung – der komplette, stellenbezogene Test braucht eine kostenlose Anmeldung.</p>

    <section class="block">
      <h2>Diese Testarten übst du hier</h2>
      <ul class="types">
        ${typeList}
      </ul>
      ${uebungenHtml}
    </section>

    ${samplesHtml}${sectionsBlock}

    ${tippsHtml}

    ${faqHtml}

    <a class="cta" href="${esc(ctaUrl)}">Test für ${esc(p.beruf)} starten →</a>

    ${relatedHtml}
  </main>
${FOOTER}
</body>
</html>
`;
}

// Hub-/Uebersichtsseite unter /einstellungstest/ — verlinkt alle Berufe (interne
// Verlinkung fuer SEO) und macht den Breadcrumb-Mittelknoten begehbar (sonst 404).
function renderHub(cat) {
  const { baseUrl } = cat;
  const url = `${baseUrl}/einstellungstest/`;
  // Einmal definiert, fuer <meta name="description"> und og:description (F9).
  const desc = "Einstellungstest gezielt nach Beruf üben: Fachfragen aus echten Stellenanzeigen plus Sprachlogik, Zahlenreihen, Konzentration und figurale Aufgaben – kostenlos mit KI-Feedback.";
  const title = "Einstellungstest nach Beruf üben – jobreif.de";
  const items = cat.pages.map((p) =>
    `<li><a href="/einstellungstest/${esc(p.slug)}/">Einstellungstest ${esc(p.beruf)}</a></li>`).join("\n        ");
  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Start", item: `${baseUrl}/` },
      { "@type": "ListItem", position: 2, name: "Einstellungstest", item: url },
    ],
  };
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${CSP}
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${url}">
  <meta name="robots" content="index, follow">
  <meta name="theme-color" content="#c5543a">
  <link rel="icon" href="/assets/icons/favicon-32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="jobreif.de">
  <meta property="og:locale" content="de_DE">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:image" content="${baseUrl}/assets/social-preview.png">
  <script type="application/ld+json">${jsonLd(ld)}</script>
  <style>
${BASE_CSS}
    ul.berufe{list-style:none;padding:0;margin:20px 0}
    ul.berufe li{margin:0 0 10px}
    ul.berufe a{display:block;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;text-decoration:none;font-weight:600;box-shadow:0 2px 8px -5px rgba(80,50,40,.25)}
    ul.berufe a:hover{border-color:var(--primary)}
    .cta{display:block;text-align:center;margin:24px 0 4px;background:var(--primary);color:#fff;text-decoration:none;font-weight:700;padding:16px 22px;border-radius:var(--radius)}
    .cta:hover{background:var(--primary-dark)}
  </style>
</head>
<body>
${HEADER}
  <main>
    <nav class="crumbs"><a href="/">Start</a> › Einstellungstest</nav>
    <h1>Einstellungstest nach Beruf üben</h1>
    <p class="lead">Wähle deinen Beruf und übe mit realistischen Aufgaben – Fachfragen aus echten Stellenanzeigen plus die typischen Eignungstest-Module. Kostenlos, im Browser, mit KI-Feedback.</p>
    <ul class="berufe">
        ${items}
    </ul>
    <a class="cta" href="/?ref=einstellungstest-hub">Eigene Stellenanzeige einfügen →</a>
  </main>
${FOOTER}
</body>
</html>
`;
}

function renderSitemap(cat) {
  const staticPages = Array.isArray(cat.staticPages) ? cat.staticPages : [];
  const urls = [
    { loc: `${cat.baseUrl}/`, lastmod: cat.updatedAt },
    // Handgepflegte Bestandsseiten (z. B. /lernen/) — duerfen beim Neuschreiben
    // der Sitemap NICHT verloren gehen.
    ...staticPages.map((s) => ({ loc: `${cat.baseUrl}${s.loc}`, lastmod: s.lastmod })),
    { loc: `${cat.baseUrl}/einstellungstest/`, lastmod: cat.updatedAt },
    ...cat.pages.map((p) => ({ loc: `${cat.baseUrl}/einstellungstest/${p.slug}/`, lastmod: p.lastmod })),
  ];
  const body = urls.map((u) =>
    `  <url>\n    <loc>${esc(u.loc)}</loc>\n    <lastmod>${esc(u.lastmod)}</lastmod>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

// --- Beruf-Kurzname (SEO-Welle Punkt 4, kompakte Linktexte) -----------------
// "beruf" traegt oft eine Geschlechter-Doppelform ("Bankkaufmann / Bankkauffrau"),
// manchmal mit einem gemeinsamen Zusatz danach ("Kaufmann / Kauffrau im
// Einzelhandel", "Fachinformatiker / Fachinformatikerin fuer Systemintegration").
// Fuer kompakte Linktexte (Footer-Block, Berufe-Karten auf den Lernseiten) faellt
// nur die zweite (feminine) Form weg - ein gemeinsamer Zusatz danach bleibt
// erhalten. Ohne das wuerden z. B. "Kaufmann / Kauffrau im Einzelhandel" UND
// "Kaufmann / Kauffrau fuer Bueromanagement" beide zu blossem "Kaufmann" -
// zwei verschiedene Ziele mit identischem, nicht unterscheidbarem Linktext.
// Kein "/" enthalten: der ganze Name bleibt stehen (z. B. "Zoll").
function berufKurz(beruf) {
  const m = beruf.match(/^(\S+) \/ \S+(.*)$/);
  return m ? `${m[1]}${m[2]}` : beruf;
}

// --- Marker-Ersetzung in handgepflegten Seiten (index.html, lernen/*.html) --
// Ersetzt NUR den Inhalt zwischen start/end-Marker, alles andere bleibt
// byte-identisch. Fehlen die Marker (z. B. weil sie versehentlich geloescht
// wurden), bricht der Lauf mit einer klaren Fehlermeldung ab statt still
// nichts zu tun oder den Marker selbst zu duplizieren.
function replaceBetweenMarkers(html, startMarker, endMarker, inner, sourceLabel) {
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `${sourceLabel}: Marker "${startMarker}" / "${endMarker}" nicht gefunden - bitte einmalig von Hand setzen.`
    );
  }
  const before = html.slice(0, startIdx + startMarker.length);
  const after = html.slice(endIdx);
  const body = inner ? `\n    ${inner}\n    ` : "\n    ";
  return `${before}${body}${after}`;
}

// --- Footer-Linkblock auf der Startseite (SEO-Welle Punkt 4) ----------------
// Generiert den Inhalt zwischen den seo-links-Markern in index.html: ein Block
// mit allen Berufsseiten und ein Block mit allen Lernseiten, die ein "label"
// tragen. Statisches HTML (kein Client-JS) - bleibt fuer Crawler auch lesbar,
// wenn die <details> beim Rendern geschlossen sind.
function renderFooterLinks(cat) {
  const berufItems = cat.pages
    .map((p) => `<li><a href="/einstellungstest/${esc(p.slug)}/">${esc(berufKurz(p.beruf))}</a></li>`)
    .join("\n          ");
  const staticPages = Array.isArray(cat.staticPages) ? cat.staticPages : [];
  const lernItems = staticPages
    .filter((s) => s && typeof s.label === "string" && s.label.trim())
    .map((s) => `<li><a href="${esc(s.loc)}">${esc(s.label)}</a></li>`)
    .join("\n          ");
  return `<div class="footer-links">
      <details>
        <summary>Einstellungstest nach Beruf</summary>
        <ul>
          ${berufItems}
        </ul>
      </details>
      <details>
        <summary>Aufgabentypen üben</summary>
        <ul>
          ${lernItems}
        </ul>
      </details>
    </div>`;
}

// --- Passende Berufe fuer eine Lernseite (SEO-Welle Punkt 4) ----------------
// (a) explizites staticPages[].berufe hat Vorrang (Redaktionsentscheidung, siehe
//     seo/catalog.json), sonst
// (b) Umkehrung von LERNEN: alle Berufsseiten, deren testTypes auf diese
//     Lernseite zeigen, PLUS alle Seiten, deren uebungen auf diese Lernseite
//     verlinken - deterministisch in Katalogreihenfolge, auf MAX_LERNEN_BERUFE
//     gedeckelt.
function berufeForLernenPage(staticPage, cat) {
  if (Array.isArray(staticPage.berufe) && staticPage.berufe.length) {
    return staticPage.berufe
      .map((slug) => cat.pages.find((p) => p.slug === slug))
      .filter(Boolean);
  }
  const testTypeKey = Object.keys(LERNEN).find((k) => LERNEN[k] === staticPage.loc);
  const out = [];
  for (const p of cat.pages) {
    const viaTestType = !!testTypeKey && Array.isArray(p.testTypes) && p.testTypes.includes(testTypeKey);
    const viaUebungen = Array.isArray(p.uebungen) && p.uebungen.some((u) => u.href === staticPage.loc);
    if (viaTestType || viaUebungen) {
      out.push(p);
      if (out.length >= MAX_LERNEN_BERUFE) break;
    }
  }
  return out;
}

// Berufe-Block auf einer Lernseite: Inhalt zwischen den seo-berufe-Markern,
// platziert vor "Weitere Aufgabentypen". Nutzt dieselbe .cards/.card-Optik wie
// der bestehende Block (lernen/lernen.css), also kein neues CSS noetig. Leer,
// falls keine passenden Berufe gefunden werden - dann bleibt zwischen den
// Markern nichts stehen, statt eine <h2> ohne Karten zu zeigen.
function renderLernenBerufe(staticPage, cat) {
  const berufe = berufeForLernenPage(staticPage, cat);
  if (!berufe.length) return "";
  const label = typeof staticPage.label === "string" && staticPage.label.trim() ? staticPage.label : "Diesem Modul";
  // Bewusst als Nominativ-Fragment statt "Mit <label> ..." (Dativ): einige Labels
  // sind Adjektiv+Nomen-Phrasen ("Kaufmännisches Rechnen", "Sprachliche Logik"),
  // deren Dativform ("kaufmännischem Rechnen") vom Nominativ abweicht - eine
  // zweite, deklinierte Fassung je Label waere Mehraufwand fuer eine Nebensache.
  // Das Fragment passt zudem zum bestehenden knappen Kartenstil dieser Seiten
  // (z. B. "Regel erkennen, nächste Zahl finden.").
  const cards = berufe
    .map((p) =>
      `<a class="card" href="/einstellungstest/${esc(p.slug)}/"><strong>Einstellungstest ${esc(berufKurz(p.beruf))}</strong><span>${esc(label)} und Fachfragen aus der Stellenanzeige.</span></a>`
    )
    .join("\n      ");
  return `<h2>Einstellungstest nach Beruf üben</h2>
    <div class="cards">
      ${cards}
    </div>`;
}

// --- Aufraeumen: verwaiste Slug-Verzeichnisse entfernen ---------------------
async function pruneStale(validSlugs) {
  let entries;
  try { entries = await readdir(outDir, { withFileTypes: true }); }
  catch { return []; }
  const removed = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!validSlugs.has(e.name)) {
      await rm(path.join(outDir, e.name), { recursive: true, force: true });
      removed.push(e.name);
    }
  }
  return removed;
}

// --- Lauf -------------------------------------------------------------------
async function main() {
  let cat;
  try {
    cat = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (e) {
    console.error(`seo/catalog.json nicht lesbar/gueltig: ${e.message}`);
    process.exit(1);
  }
  const errs = validate(cat);
  if (errs.length) {
    console.error("SEO-Katalog ungueltig:");
    errs.forEach((m) => console.error(`  - ${m}`));
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const slugs = new Set(cat.pages.map((p) => p.slug));
  const removed = await pruneStale(slugs);

  await writeFile(path.join(outDir, "index.html"), renderHub(cat), "utf8");
  for (const [i, p] of cat.pages.entries()) {
    const dir = path.join(outDir, p.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), renderPage(p, cat, i), "utf8");
  }
  await writeFile(path.join(root, "sitemap.xml"), renderSitemap(cat), "utf8");

  // index.html: Footer-Linkblock (SEO-Welle Punkt 4) - nur der Marker-Bereich
  // im Footer wird ersetzt, der Rest der Datei bleibt byte-identisch.
  try {
    const indexPath = path.join(root, "index.html");
    const indexHtml = await readFile(indexPath, "utf8");
    const nextIndexHtml = replaceBetweenMarkers(
      indexHtml, MARK_LINKS_START, MARK_LINKS_END, renderFooterLinks(cat), "index.html"
    );
    await writeFile(indexPath, nextIndexHtml, "utf8");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  // lernen/*.html: Berufe-Block (alle staticPages ausser /lernen/ selbst).
  const staticPages = Array.isArray(cat.staticPages) ? cat.staticPages : [];
  for (const s of staticPages) {
    if (!s || s.loc === "/lernen/") continue;
    const filePath = path.join(root, s.loc.replace(/^\//, ""));
    try {
      const html = await readFile(filePath, "utf8");
      const next = replaceBetweenMarkers(
        html, MARK_BERUFE_START, MARK_BERUFE_END, renderLernenBerufe(s, cat), s.loc
      );
      await writeFile(filePath, next, "utf8");
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }

  const staticCount = staticPages.length;
  const sitemapUrls = 1 /* root */ + staticCount + 1 /* hub */ + cat.pages.length;
  console.log(`SEO generiert: Hub + ${cat.pages.length} Beruf-Seite(n), sitemap.xml mit ${sitemapUrls} URLs.`);
  console.log(`Footer-Linkblock (index.html) und Berufe-Bloecke (${staticPages.length - 1} Lernseite(n)) aktualisiert.`);
  if (removed.length) console.log(`Entfernt (nicht mehr im Katalog): ${removed.join(", ")}`);
}

// Nur ausfuehren, wenn direkt als CLI-Skript gestartet (node scripts/generate-seo.mjs) -
// nicht beim Import (z. B. aus einem Test, der nur validate() isoliert prüfen will).
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main();
}

export { validate, renderFooterLinks, renderLernenBerufe, berufeForLernenPage, berufKurz };
