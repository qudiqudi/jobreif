"use strict";

// Wächter gegen versehentliche Veröffentlichung von Interna.
//
// Dieses Repo ist öffentlich UND wird als Ganzes von GitHub Pages ausgeliefert
// (deploy.yml lädt den Checkout hoch). Alles, was hier landet, ist damit sowohl
// auf github.com als auch auf der Produktionsdomain abrufbar. Die serverseitige
// Komponente liegt bewusst außerhalb dieses Repos; ihre Bausteine, Namen und
// Betriebsgeheimnisse dürfen hier nicht auftauchen — weder in Code noch in
// Kommentaren, Dokumentation oder generierten Seiten.
//
// Die Begriffsliste steht base64-kodiert im Quelltext. Das ist KEIN Schutz vor
// einem Leser (base64 ist trivial umkehrbar) und soll auch keiner sein. Der Zweck
// ist enger: Die verbotenen Zeichenketten sollen nicht im Klartext in einer
// öffentlichen, von Suchmaschinen und Code-Suchen indexierten Datei stehen —
// sonst würde ausgerechnet der Wächter die Begriffe publizieren, die er verbietet.
const FORBIDDEN_B64 = [
  "am9icmVpZi1iYWNrZW5k",       // Name des nicht-öffentlichen Repos
  "Y2xvYWticm93c2Vy",           // interne Komponente
  "R29sZGVuLVNldA==",           // interne Komponente
  "QnVkZ2V0LUdhdGU=",           // interne Komponente
  "UHJlbWl1bS1Qcm9tcHQ=",       // interne Komponente
  "T1BFTlJPVVRFUl9LRVk=",       // Secret-Name
  "VFVSTlNUSUxFX1NFQ1JFVA==",   // Secret-Name
  "QURNSU5fU0VDUkVU",           // Secret-Name
  "VEVTVF9TVUJKRUNUUw==",       // Secret-Name
  "UEFJRF9EQVlfQlVER0VUX1VTRA==", // Secret-Name
];

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const terms = FORBIDDEN_B64.map((b) => Buffer.from(b, "base64").toString("utf8").toLowerCase());

// Sich selbst nicht prüfen (enthält die Liste), und keine Binärdateien lesen.
// NUR echte Binärformate gehören in SKIP_EXT. Textformate niemals überspringen —
// `.svg` stand hier einmal fälschlich drin: SVG ist Klartext, wird ausgeliefert und
// ist indexierbar, ein Kommentar darin wäre unbemerkt durchgerutscht (Review-Fund).
const SELF = ".github/scripts/check-no-internals.js";
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

// Maskiert einen Treffer, damit die CI-Logs (ebenfalls öffentlich) den Begriff
// nicht im Klartext wiederholen. Der Dateiname und die Zeile genügen zum Finden.
const mask = (t) => t.slice(0, 3) + "…" + `(${t.length})`;

const hits = [];
for (const file of files) {
  if (file === SELF) continue;
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue;
  let text;
  try {
    text = fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    continue; // unlesbar/binär → überspringen
  }
  const lower = text.toLowerCase();
  if (!terms.some((t) => lower.includes(t))) continue;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const l = line.toLowerCase();
    for (const t of terms) {
      if (l.includes(t)) hits.push(`${file}:${i + 1}: verbotener Begriff ${mask(t)}`);
    }
  });
}

if (hits.length) {
  console.error("Interna im öffentlichen Repo gefunden:\n");
  hits.forEach((h) => console.error("  " + h));
  console.error(
    "\nDieses Repo ist öffentlich und wird komplett von GitHub Pages ausgeliefert." +
      "\nServerseitige Komponenten, ihre Namen und Secret-Namen gehören nicht hierher." +
      "\nDie Begriffsliste steht in " + SELF + "."
  );
  process.exit(1);
}

console.log(`Interna-Prüfung OK (${files.length} Dateien, ${terms.length} Begriffe).`);
