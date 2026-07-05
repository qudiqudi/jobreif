# Vendored third-party libraries

## qrcodegen.js — QR Code generator

- **Upstream**: nayuki/QR-Code-generator — https://github.com/nayuki/QR-Code-generator
- **Library page**: https://www.nayuki.io/page/qr-code-generator-library
- **License**: MIT (© Project Nayuki) — full text retained in the file header.
- **Source**: `typescript-javascript/qrcodegen.ts`
- **Pinned at commit**: `2c9044de6b049ca25cb3cd1649ed7e27aa055138` (upstream master, gezogen 2026-07-05).
- **Wie erzeugt** (Nayukis eigene `build.sh`, nur die Bibliothek, ohne die Demo-Dateien):

  ```
  tsc --strict --lib DOM,DOM.Iterable,ES6 --target ES6 qrcodegen.ts
  ```

  Das Ergebnis ist diese eine, dependency-freie Datei; sie setzt beim Laden als klassisches
  `<script>` das globale `qrcodegen` (mit `qrcodegen.QrCode`). Kein Build-Schritt beim Deploy —
  das kompilierte Artefakt ist committet (die PWA ist self-contained, kein CDN).

Wir nutzen die Lib nur als reinen Encoder (Modul-Matrix via `QrCode.encodeText(...).getModule(x,y)`);
das SVG-Rendering macht unser eigenes `assets/sync-qr.js`.
