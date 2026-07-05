"use strict";

// Geraete-Sync — QR-Rendering. Duenne, eigene Schicht ueber dem vendorten Encoder
// (assets/vendor/qrcodegen.js, MIT, Nayuki): aus der Modul-Matrix ein self-contained SVG.
//
// Bewusst SCHWARZE Module auf WEISSEM Grund — auch im Dark-Mode. Invertierte QR-Codes (helle
// Module auf dunkel) scannen viele Kamera-Apps unzuverlaessig; die weisse Ruhezone (quiet zone)
// bleibt Teil des Codes. Die Karte rahmt den Code hell ein, der QR selbst wird nie umgefaerbt.
//
// UMD: klassisches <script> (window.SyncQR) und per require() testbar. Der Encoder wird zur
// Laufzeit aus dem globalen `qrcodegen` gezogen (Browser: global; Test: via globalThis gesetzt).

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SyncQR = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {

  function lib() {
    const g = (typeof qrcodegen !== "undefined" && qrcodegen)
      || (typeof globalThis !== "undefined" && globalThis.qrcodegen)
      || (typeof window !== "undefined" && window.qrcodegen);
    if (!g || !g.QrCode) throw new Error("qrcodegen (Encoder) nicht geladen");
    return g;
  }

  // Fehlerkorrektur MEDIUM: guter Kompromiss aus Robustheit und Dichte fuer eine kurze URL.
  function encode(text) {
    const g = lib();
    return g.QrCode.encodeText(String(text), g.QrCode.Ecc.MEDIUM);
  }

  // SVG-String fuer eine beliebige Nutzlast (hier: die Kopplungs-URL). Koordinaten in MODUL-
  // Einheiten (viewBox), die sichtbare Groesse skaliert der Container/`size`-Attribut — dadurch
  // ist der Code bei jeder Groesse gestochen scharf. `margin` = Ruhezone in Modulen (Standard 4).
  function svg(text, opts) {
    const o = opts || {};
    const margin = Number.isInteger(o.margin) ? o.margin : 4;
    const dark = o.dark || "#000000";
    const light = o.light || "#ffffff";
    const qr = encode(text);
    const dim = qr.size + margin * 2;

    // Alle dunklen Module in EINEN Path (kompakt) — je Modul ein 1x1-Rechteck.
    let d = "";
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.getModule(x, y)) d += `M${x + margin} ${y + margin}h1v1h-1z`;
      }
    }
    const attrs = [
      `xmlns="http://www.w3.org/2000/svg"`,
      `viewBox="0 0 ${dim} ${dim}"`,
      `shape-rendering="crispEdges"`,
      `role="img"`,
      o.title ? `aria-label="${String(o.title).replace(/"/g, "&quot;")}"` : `aria-hidden="true"`,
    ];
    if (o.size) { attrs.push(`width="${o.size}"`, `height="${o.size}"`); }
    return `<svg ${attrs.join(" ")}>`
      + `<rect width="${dim}" height="${dim}" fill="${light}"/>`
      + `<path d="${d}" fill="${dark}"/>`
      + `</svg>`;
  }

  // Bequemer fuer <img src> / CSS: data-URI des SVG (utf8, nicht base64 → kleiner + diffbar).
  function dataUrl(text, opts) {
    const s = svg(text, opts);
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
  }

  return { svg, dataUrl, encode };
});
