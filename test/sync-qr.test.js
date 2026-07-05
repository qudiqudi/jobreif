"use strict";

// QR-Renderer-Regression (Geraete-Sync F1b): prueft, dass unser SVG-Renderer (assets/sync-qr.js)
// aus der Modul-Matrix des vendorten Nayuki-Encoders (assets/vendor/qrcodegen.js) ein korrektes,
// self-contained SVG erzeugt. Der Encoder wird — wie im Browser als globales `qrcodegen` — hier
// in globalThis geladen. Start: node test/sync-qr.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Vendor-Encoder als klassisches Script in den GLOBALEN Scope laden (setzt globalThis.qrcodegen).
const vendorSrc = fs.readFileSync(path.join(__dirname, "..", "assets", "vendor", "qrcodegen.js"), "utf8");
vm.runInThisContext(vendorSrc + "\n; if (typeof qrcodegen !== 'undefined') globalThis.qrcodegen = qrcodegen;");

const SyncQR = require("../assets/sync-qr.js");

let failures = 0;
function assert(cond, msg) { if (cond) { console.log("  ok:", msg); return; } failures++; console.error("  FAIL:", msg); }
function eq(a, b, msg) { assert(a === b, `${msg} (erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)})`); }

const URL_SAMPLE = "https://jobreif.de/#sync=v1.4PW1V7XRS62ZNQSX4B0T4FSDF4";

function run() {
  // 1) Encoder liefert eine plausible Matrix
  {
    const qr = SyncQR.encode(URL_SAMPLE);
    assert(qr.size >= 21 && qr.size <= 177, "QR-Size in gueltigem Bereich");
    assert(typeof qr.getModule(0, 0) === "boolean", "getModule → boolean");
  }

  // 2) SVG-Grundstruktur: valides Wrapper-Element, weisser Grund, schwarzer Modul-Path
  {
    const s = SyncQR.svg(URL_SAMPLE);
    assert(s.startsWith("<svg ") && s.endsWith("</svg>"), "SVG-Wrapper");
    assert(/viewBox="0 0 \d+ \d+"/.test(s), "viewBox gesetzt");
    assert(s.includes('fill="#ffffff"'), "weisser Hintergrund (nicht invertiert)");
    assert(s.includes('fill="#000000"'), "schwarze Module");
    assert(s.includes('shape-rendering="crispEdges"'), "crispEdges fuer scharfe Kanten");
    // Kein externer Verweis (self-contained, CSP-fest)
    assert(!/https?:\/\//.test(s.replace(/xmlns="[^"]*"/, "")), "keine externen Referenzen im SVG");
  }

  // 3) viewBox = size + 2*margin; Modul-Anzahl im Path == Anzahl dunkler Module
  {
    const margin = 4;
    const qr = SyncQR.encode(URL_SAMPLE);
    let darkCount = 0;
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) darkCount++;
    const s = SyncQR.svg(URL_SAMPLE, { margin });
    const dim = qr.size + margin * 2;
    assert(s.includes(`viewBox="0 0 ${dim} ${dim}"`), "viewBox = size + 2*margin (Ruhezone)");
    const rects = (s.match(/M\d+ \d+h1v1h-1z/g) || []).length;
    eq(rects, darkCount, "Path-Rechtecke == dunkle Module");
  }

  // 4) Deterministisch: gleiche Eingabe → gleiches SVG
  {
    eq(SyncQR.svg(URL_SAMPLE), SyncQR.svg(URL_SAMPLE), "SVG deterministisch");
  }

  // 5) size-Attribut + Titel (a11y) optional
  {
    const s = SyncQR.svg(URL_SAMPLE, { size: 220, title: "Kopplungs-QR" });
    assert(s.includes('width="220"') && s.includes('height="220"'), "size setzt width/height");
    assert(s.includes('aria-label="Kopplungs-QR"'), "Titel → aria-label");
    const s2 = SyncQR.svg(URL_SAMPLE);
    assert(s2.includes('aria-hidden="true"'), "ohne Titel → aria-hidden");
  }

  // 6) dataUrl ist ein utf8 SVG-Data-URI
  {
    const u = SyncQR.dataUrl(URL_SAMPLE);
    assert(u.startsWith("data:image/svg+xml;charset=utf-8,"), "dataUrl-Praefix");
    assert(decodeURIComponent(u.slice("data:image/svg+xml;charset=utf-8,".length)).startsWith("<svg "), "dataUrl dekodiert zu SVG");
  }

  console.log(failures === 0 ? "\nALLE TESTS OK" : `\n${failures} FEHLER`);
  if (failures > 0) process.exit(1);
}

run();
