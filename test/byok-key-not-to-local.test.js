"use strict";

// Der BYOK-Cloud-Key darf NIE an den lokalen Modellserver gehen.
//
// settings.apiKey bleibt beim Wechsel auf den Anbieter "local" absichtlich gespeichert — er ist
// die Zugangsberechtigung des BYOK-Fallbacks, und geloescht wuerde er beim Zurueckwechseln
// fehlen. Das Key-Feld ist fuer "local" aber ausgeblendet: ein dort gesetzter Key ist damit
// praktisch immer ein Cloud-Secret (OpenAI/DeepSeek/Anthropic) aus einer frueheren Auswahl.
// Ging er als `Authorization: Bearer` an localBaseUrl(), landete dieses Secret bei Ollama,
// LM Studio oder was sonst unter der eingetragenen Adresse lauscht — ohne dass der Nutzer davon
// etwas sieht. Genau das prueft dieser Test, und zwar an der ECHTEN callLLM aus app.js: die
// Funktion wird per Klammer-Balance extrahiert und in einer vm-Sandbox mit gestubbtem fetch
// gefahren, das die tatsaechlich gesendeten Header festhaelt.
//
// Start: node test/byok-key-not-to-local.test.js

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Wie in gespraechsstufe-per-request.test.js: fuehrendes "async" mit heraus, und der Rumpf erst
// NACH der Parameterliste suchen (callLLM hat ein `opts = {}` als Default-Wert).
function funcSrc(name) {
  const re = new RegExp("(?:async\\s+)?function " + name + "\\b");
  const m = re.exec(src);
  if (!m) throw new Error("nicht gefunden: function " + name);
  let i = src.indexOf("(", m.index), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) { i++; break; }
  }
  i = src.indexOf("{", i);
  depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { if (--depth === 0) return src.slice(m.index, i + 1); } }
  throw new Error("keine Klammer-Balance: " + name);
}

let failures = 0;
const assert = (cond, msg) => { if (cond) { console.log("  ok:", msg); } else { failures++; console.error("  FAIL:", msg); } };
const eq = (a, b, msg) => assert(a === b, `${msg} (erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)})`);

const LOCAL_URL = "http://127.0.0.1:11434/v1";

// Faehrt die echte callLLM bis zum fetch und liefert {url, headers} des Aufrufs zurueck.
// Der fetch-Stub wirft danach, damit die Funktion nicht in die Stream-Verarbeitung laeuft —
// den Wurf faengt der Aufrufer ab, geprueft wird nur, was gesendet WURDE.
async function capture(settings) {
  const sandbox = { console, JSON, Error, Promise };
  vm.createContext(sandbox);
  vm.runInContext([
    "var __sent = null;",
    "var settings = " + JSON.stringify(settings) + ";",
    "function localBaseUrl() { return " + JSON.stringify(LOCAL_URL) + "; }",
    // Nur der Cloud-Zweig braucht den Modellkatalog.
    "function modelsFor() { return [{ id: 'gpt-5.1' }]; }",
    "function apiErrorMessage() { return 'fehler'; }",
    "function callHosted() { throw new Error('hosted nicht Teil dieses Tests'); }",
    "async function fetch(url, init) { __sent = { url, headers: (init && init.headers) || {} }; throw new Error('stop-nach-fetch'); }",
    funcSrc("callLLM"),
    "globalThis.__x = { callLLM, get sent() { return __sent; } };",
  ].join("\n"), sandbox);
  const x = sandbox.__x;
  try { await x.callLLM("sys", "user", { type: "object" }, null, {}); }
  catch { /* erwartet: der Stub bricht nach dem fetch ab */ }
  return x.sent;
}

async function run() {
  const LEFTOVER = "sk-uebriggebliebenes-cloud-secret";

  // 1) Kernfall: Anbieter "local", im Speicher liegt noch ein Cloud-Key.
  {
    const sent = await capture({ provider: "local", model: "llama3.1", apiKey: LEFTOVER });
    assert(!!sent, "lokaler Anbieter: fetch wurde ueberhaupt abgesetzt");
    assert(sent.url.startsWith(LOCAL_URL), "lokaler Anbieter: Ziel ist der lokale Server");
    eq(sent.headers.Authorization, undefined, "KEIN Authorization-Header an den lokalen Server");
    const alle = JSON.stringify(sent.headers);
    assert(!alle.includes(LEFTOVER), "der Cloud-Key taucht in KEINEM Header auf");
  }

  // 2) Ohne gespeicherten Key aendert sich am lokalen Pfad nichts.
  {
    const sent = await capture({ provider: "local", model: "llama3.1", apiKey: "" });
    eq(sent.headers.Authorization, undefined, "lokal ohne Key: weiterhin kein Authorization-Header");
    eq(sent.headers["Content-Type"], "application/json", "lokal: uebrige Header unveraendert");
  }

  // 3) Gegenprobe — die Cloud-Anbieter brauchen den Bearer und bekommen ihn weiterhin.
  for (const p of ["openai", "deepseek"]) {
    const sent = await capture({ provider: p, model: "gpt-5.1", apiKey: "sk-echter-key" });
    eq(sent.headers.Authorization, "Bearer sk-echter-key", `${p}: Bearer wird weiterhin gesendet`);
    assert(!sent.url.startsWith(LOCAL_URL), `${p}: Ziel ist NICHT der lokale Server`);
  }

  console.log(failures === 0 ? "\nAlle Checks bestanden." : `\n${failures} Check(s) fehlgeschlagen.`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
