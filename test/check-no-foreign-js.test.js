"use strict";

// Regression für den Fremd-JS-Wächter (.github/scripts/check-no-foreign-js.js):
// prüft die Kandidaten-Erkennung isoliert gegen Wegwerf-Fixtures und führt zum
// Schluss das main-Skript gegen den echten Repo-Stand aus (Smoke-Test).
//
// WICHTIG: Fixtures hier verwenden AUSSCHLIESSLICH synthetische Namen
// ("zzz-fremd.js" u. ä.), nie echte serverseitige Dateinamen — diese Datei
// wird selbst öffentlich ausgeliefert.
//
// Start: node test/check-no-foreign-js.test.js

const { execFileSync } = require("child_process");
const path = require("path");
const { findForeignJs, EXCEPTIONS } = require("../.github/scripts/check-no-foreign-js.js");

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

function run() {
  // a) Fremdname wird gefangen
  {
    const hits = findForeignJs("// vgl. zzz-fremd.js", new Set(), EXCEPTIONS);
    eq(hits.length, 1, "a) Fremdname wird als 1 Treffer gefangen");
    if (hits.length === 1) eq(hits[0].name, "zzz-fremd.js", "a) Trefferinhalt korrekt");
  }

  // b) existierender Name passiert
  {
    const hits = findForeignJs("siehe app.js", new Set(["app.js"]), EXCEPTIONS);
    eq(hits.length, 0, "b) existierender Name erzeugt keinen Treffer");
  }

  // c) Ausnahme passiert
  {
    const hits = findForeignJs("paddle.js", new Set(), EXCEPTIONS);
    eq(hits.length, 0, "c) Ausnahme (klein) erzeugt keinen Treffer");
  }

  // d) Großschreibung der Ausnahme passiert
  {
    const hits = findForeignJs("Paddle.js", new Set(), EXCEPTIONS);
    eq(hits.length, 0, "d) Ausnahme (groß) erzeugt keinen Treffer");
  }

  // e) Mehrpunkt-Name als Ganzes, kein "test.js"-Phantom
  {
    const existing = new Set(["sync-crypto.test.js"]);
    const hits = findForeignJs("node test/sync-crypto.test.js", existing, EXCEPTIONS);
    eq(hits.length, 0, "e) Mehrpunkt-Name (existierend) erzeugt keinen Treffer");
    assert(
      !hits.some((h) => h.name === "test.js"),
      "e) kein 'test.js'-Phantom-Kandidat"
    );
  }

  // f) URL mit Fremdname fängt; URL mit Ausnahme passiert
  {
    const hits1 = findForeignJs("https://example.com/zzz-fremd.js", new Set(), EXCEPTIONS);
    eq(hits1.length, 1, "f) URL mit Fremdname wird gefangen");

    const hits2 = findForeignJs("https://cdn.paddle.com/paddle/v2/paddle.js", new Set(), EXCEPTIONS);
    eq(hits2.length, 0, "f) URL mit Ausnahme-Name passiert");
  }

  // g) Escape-Normalisierung: \n vor bekanntem Namen passiert, vor Fremdnamen fängt (fail-closed)
  {
    const line1 = 'console.log("\\nsync-merge.test.js OK")';
    const hits1 = findForeignJs(line1, new Set(["sync-merge.test.js"]), EXCEPTIONS);
    eq(hits1.length, 0, "g) Escape-normalisiert: bekannter Name nach \\n passiert");

    const line2 = 'console.log("\\n" + "zzz-fremd.js")';
    const hits2 = findForeignJs(line2, new Set(), EXCEPTIONS);
    eq(hits2.length, 1, "g) fail-closed: Fremdname nach \\n wird weiterhin gefangen");
  }

  // h) Pfad-Basename
  {
    const hits = findForeignJs("assets/sync-qr.js", new Set(["sync-qr.js"]), EXCEPTIONS);
    eq(hits.length, 0, "h) Pfad mit existierendem Basename passiert");
  }

  // i) .jsx wird nicht geflaggt
  {
    const hits = findForeignJs("Component.jsx", new Set(), EXCEPTIONS);
    eq(hits.length, 0, "i) .jsx erzeugt keinen Treffer");
  }

  // Zusatz-Smoke: main-Skript gegen den echten Repo-Stand ausführen
  {
    const script = path.join(__dirname, "..", ".github", "scripts", "check-no-foreign-js.js");
    try {
      const out = execFileSync("node", [script], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
      assert(/OK/.test(out), "Smoke: main-Skript läuft grün auf dem echten Repo-Stand");
    } catch (e) {
      failures++;
      console.error("  FAIL: Smoke: main-Skript schlug fehl:\n" + (e.stdout || "") + (e.stderr || ""));
    }
  }

  console.log(failures === 0 ? "\nALLE TESTS OK" : `\n${failures} FEHLER`);
  if (failures > 0) process.exit(1);
}

run();
