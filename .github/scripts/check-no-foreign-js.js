"use strict";

// Wächter gegen Verweise auf serverseitige Skript-Namen im öffentlichen Repo.
//
// Regel: Jeder im Repo erwähnte .js/.mjs-Dateiname muss entweder als getrackte
// Datei im Repo existieren oder auf der Ausnahmeliste öffentlicher Fremd-Skripte
// (unten) stehen. Sonst schlägt der Check fehl.
//
// Warum: Dieses Repo ist öffentlich UND wird als Ganzes von GitHub Pages
// ausgeliefert. Ein Verweis auf ein Skript, das nicht hier liegt ("siehe
// xyz.js im Backend"), verrät serverseitige Dateistruktur, ohne dass die
// verbotene Zeichenkette je in einer Begriffsliste stehen müsste — genau die
// Lücke, die eine handgepflegte Sperrliste (siehe check-no-internals.js) nicht
// schließen kann, weil sie nur bereits bekannte Begriffe fängt.
//
// Diese Regel kommt bewusst OHNE jede Kenntnis serverseitiger Dateinamen aus:
// sie prüft nur "existiert der genannte Name hier im Repo?". Eine Positivliste
// serverseitiger Namen wäre die Umkehrung des Problems — sie würde genau die
// Dateiliste veröffentlichen, die sie eigentlich schützen soll.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Ausnahmen NUR für öffentliche Fremd-Skripte, die absichtlich nicht im Repo
// liegen (fremde SDKs, extern gehostet, oder lokale/gitignorete Hilfsskripte).
// Jede Ergänzung braucht eine Begründung im Review. Keys lowercase.
const EXCEPTIONS = new Map([
  ["api.js", "Cloudflare-Turnstile-SDK (challenges.cloudflare.com), eingebunden in index.html"],
  ["paddle.js", "Paddle-SDK (cdn.paddle.com), nachgeladen in app.js; auch als 'Paddle.js' im CSP-Kommentar"],
  ["gsc-status.mjs", "lokales, bewusst ungetracktes Hilfsskript (siehe .gitignore)"],
]);

// Kandidaten-Erkennung als reine Funktion, damit sie sich isoliert testen lässt.
//
// existing: Set von lowercase-Basenamen aller getrackten .js/.mjs-Dateien.
// exceptions: Map wie EXCEPTIONS (nur .has() wird benutzt).
function findForeignJs(text, existing, exceptions) {
  const hits = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    // Escape-Normalisierung: Die Zweizeichenfolge Backslash+n/r/t im Quelltext
    // ist ein String-Escape, kein Bestandteil eines Dateinamens (z. B. in
    // console.log("\nfoo.js")). Ohne diesen Schritt frisst die gierige
    // Zeichenklasse unten das führende Zeichen nach dem Escape und erzeugt ein
    // Phantom ("nfoo.js" statt "foo.js"). Fail-closed: aus "\n" + Fremdname
    // wird " " + Fremdname → wird weiterhin gefangen.
    const norm = line.toLowerCase().replace(/\\[nrt]/g, " ");
    // Zeichenklasse enthält Punkt, Bindestrich UND Slash, damit Mehrpunkt-Namen
    // (a.test.js) und Pfade (dir/a.js) als GANZES gegriffen werden statt in
    // Fragmente zu zerfallen. \b am Ende verhindert .jsx/.json-Fehltreffer.
    // URLs brauchen keine Sonderbehandlung: ":" bricht die Zeichenklasse, der
    // Rest ab dem Host/Pfad wird normal gematcht und dann per Segment geprüft.
    const re = /[a-z0-9_][a-z0-9_.\/-]*\.(?:js|mjs)\b/g;
    let m;
    while ((m = re.exec(norm))) {
      // Jedes Pfadsegment einzeln prüfen, nicht nur das letzte: sonst würde ein
      // Fremdname, der VOR einem existierenden Basenamen steht (z. B.
      // "fremd.js/app.js" als ein einziger Match), von split("/").pop() nie
      // ausgewertet und stillschweigend durchgelassen — ein Fail-Open-Loch im
      // sonst fail-closed gemeinten Wächter.
      for (const seg of m[0].split("/")) {
        if (!/\.(?:js|mjs)$/.test(seg)) continue; // Zwischensegment ohne Endung
        if (!existing.has(seg) && !exceptions.has(seg)) {
          hits.push({ line: i + 1, name: seg });
        }
      }
    }
  });
  return hits;
}

function main() {
  const root = path.join(__dirname, "..", "..");

  // Sich selbst und die eigene Testdatei nicht prüfen: beide enthalten
  // synthetische Fremdnamen als Fixtures bzw. Doku-Beispiele, die selbst nicht
  // im Repo existieren (das ist ihr Zweck).
  const SELF = new Set([".github/scripts/check-no-foreign-js.js", "test/check-no-foreign-js.test.js"]);
  // NUR echte Binärformate hier. Textformate niemals überspringen (siehe
  // Review-Fund zu .svg in check-no-internals.js).
  const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".ico", ".ttf", ".woff", ".woff2", ".webp", ".pdf"]);

  let files;
  try {
    files = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch (e) {
    console.error(`Konnte die getrackten Dateien nicht ermitteln: ${e.message}`);
    process.exit(1);
  }

  // existing MUSS aus git ls-files kommen, nicht aus dem Dateisystem: eine
  // lokale, ungetrackte Datei (z. B. ein gitignoretes Hilfsskript) würde sonst
  // ihre eigene Erwähnung lokal grün waschen, während CI (ohne diese Datei) rot
  // wäre — oder umgekehrt Scratch-Dateien Lücken öffnen.
  const existing = new Set();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext === ".js" || ext === ".mjs") {
      existing.add(path.basename(f).toLowerCase());
    }
  }

  const mask = (t) => t.slice(0, 3) + "…" + `(${t.length})`;

  const hits = [];
  for (const file of files) {
    if (SELF.has(file)) continue;
    if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      continue; // unlesbar/binär → überspringen
    }
    const found = findForeignJs(text, existing, EXCEPTIONS);
    for (const f of found) {
      hits.push(`${file}:${f.line}: ${mask(f.name)}`);
    }
  }

  if (hits.length) {
    console.error("Erwähnter JS-Dateiname existiert nicht im Repo:\n");
    hits.forEach((h) => console.error("  " + h));
    console.error(
      "\nJeder im Repo erwähnte .js/.mjs-Name muss als Datei im Repo existieren oder auf der" +
        "\nAusnahmeliste öffentlicher Fremd-Skripte stehen. Dieses Repo ist öffentlich und wird" +
        "\nvon GitHub Pages ausgeliefert — Verweise auf anderswo liegende Skripte gehören nicht" +
        "\nhierher. Optionen:" +
        "\n  1) Tippfehler/Pfad korrigieren bzw. die Datei einchecken, falls sie hierher gehört." +
        "\n  2) Die Erwähnung umformulieren oder entfernen." +
        "\n  3) Nur für öffentliche Fremd-SDKs: mit Begründung in EXCEPTIONS" +
        "\n     (.github/scripts/check-no-foreign-js.js) eintragen."
    );
    process.exit(1);
  }

  console.log(
    `Fremd-JS-Prüfung OK (${files.length} Dateien, ${existing.size} bekannte Basenamen, ${EXCEPTIONS.size} Ausnahmen).`
  );
}

if (require.main === module) {
  main();
} else {
  module.exports = { findForeignJs, EXCEPTIONS };
}
