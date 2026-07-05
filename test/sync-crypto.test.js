"use strict";

// Krypto-Layer-Regression (Geraete-Sync F1a): seed/code-Roundtrip, HKDF/AES-GCM enc/dec-
// Roundtrip, kid-Determinismus + „falscher Schluessel"-Erkennung, Envelope-Form, QR-Fragment-
// Parsing + Konsum (Fragment wird aus URL entfernt). Kein Netz, kein Browser: WebCrypto kommt
// aus globalThis.crypto (Node >=18). Start: node test/sync-crypto.test.js

const SC = require("../assets/sync-crypto.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ok:", msg); return; }
  failures++;
  console.error("  FAIL:", msg);
}
function eq(a, b, msg) { assert(a === b, `${msg} (erwartet ${JSON.stringify(b)}, war ${JSON.stringify(a)})`); }
async function throws(fn, msg) {
  try { await fn(); failures++; console.error("  FAIL:", msg, "(kein Wurf)"); }
  catch { assert(true, msg); }
}
function bytesEq(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }

async function run() {
  // 1) Seed → Code → Seed Roundtrip (viele Zufalls-Seeds; Code ist 26 Zeichen Crockford)
  {
    let allOk = true, lenOk = true;
    for (let i = 0; i < 200; i++) {
      const seed = SC.generateSeed();
      if (seed.length !== 16) lenOk = false;
      const code = SC.seedToCode(seed);
      if (code.length !== SC.CODE_LEN) lenOk = false;
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(code)) lenOk = false; // Crockford-Alphabet
      if (!bytesEq(SC.codeToSeed(code), seed)) allOk = false;
    }
    assert(lenOk, "Seed=16 Byte, Code=26 Crockford-Zeichen");
    assert(allOk, "seed→code→seed Roundtrip (200 Zufalls-Seeds)");
  }

  // 2) Code-Eingabe-Toleranz: Klein/gross, Bindestriche, Crockford-Verwechsler (I/L→1, O→0)
  {
    const seed = SC.codeToSeed("00000000000000000000000000");
    assert(bytesEq(seed, new Uint8Array(16)), "Null-Code → 16 Null-Byte");
    const seedA = SC.generateSeed();
    const canon = SC.seedToCode(seedA);
    const grouped = SC.formatCode(canon);
    assert(/^.{5}-.{5}-.{5}-.{5}-.{6}$/.test(grouped), "formatCode → 5-5-5-5-6");
    assert(bytesEq(SC.codeToSeed(grouped), seedA), "gruppierter Code dekodiert identisch");
    assert(bytesEq(SC.codeToSeed(canon.toLowerCase()), seedA), "kleingeschrieben dekodiert identisch");
    // Crockford-Nachsicht: I/i/L/l werden als 1 gelesen, O/o als 0.
    assert(bytesEq(SC.codeToSeed("I0I0I0I0I0I0I0I0I0I0I0I0I0"),
                   SC.codeToSeed("10101010101010101010101010")), "I→1 Nachsicht");
    assert(bytesEq(SC.codeToSeed("1O1O1O1O1O1O1O1O1O1O1O1O1O"),
                   SC.codeToSeed("10101010101010101010101010")), "O→0 Nachsicht");
    assert(SC.normalizeCode("nicht-valide!") === null, "normalizeCode: ungueltig → null");
    assert(SC.normalizeCode(canon.slice(0, 25)) === null, "normalizeCode: zu kurz → null");
  }

  // 3) Ungueltige Codes werfen
  {
    await throws(() => { SC.codeToSeed("ABC"); }, "zu kurzer Code wirft");
    await throws(() => { SC.codeToSeed("UUUUUUUUUUUUUUUUUUUUUUUUUU"); }, "U (nicht im Alphabet) wirft");
    await throws(() => { SC.codeToSeed(12345); }, "Nicht-String wirft");
  }

  // 4) kid ist deterministisch fuer denselben Seed, verschieden fuer andere Seeds
  {
    const seed = SC.generateSeed();
    const a = await SC.deriveKey(seed);
    const b = await SC.deriveKey(SC.seedToCode(seed)); // aus Code abgeleitet → gleich
    eq(a.kid, b.kid, "kid deterministisch (Seed == Code-abgeleitet)");
    assert(/^[0-9a-f]{8}$/.test(a.kid), "kid = 8 Hex");
    const other = await SC.deriveKey(SC.generateSeed());
    assert(a.kid !== other.kid, "kid verschieden fuer anderen Seed");
  }

  // 5) enc/dec Roundtrip; Envelope-Form; frische IV pro Write; kid-Mismatch/falscher Schluessel
  {
    const seed = SC.generateSeed();
    const { key, kid } = await SC.deriveKey(seed);
    const payload = { profile: { ort: "Berlin", ziel: "PM" }, tier: "standard", updatedAt: 1720000000000, nested: [1, 2, { a: "ä€\"'" }] };
    const env1 = await SC.encrypt(key, kid, payload);
    assert(SC.isEnvelope(env1), "Envelope hat gueltige Form");
    eq(env1.v, 1, "v=1");
    eq(env1.kid, kid, "Envelope traegt die kid");
    const back = await SC.decrypt(key, env1);
    eq(JSON.stringify(back), JSON.stringify(payload), "enc→dec Roundtrip (inkl. Unicode/nested)");

    const env2 = await SC.encrypt(key, kid, payload);
    assert(env1.iv !== env2.iv, "frische IV pro Write");
    assert(env1.ct !== env2.ct, "Chiffrat unterscheidet sich (IV-Zufall)");

    // Falscher Schluessel → GCM-Auth-Fehler (Wurf). kid signalisiert es vorher ohne Entschluesseln.
    const wrong = await SC.deriveKey(SC.generateSeed());
    assert(wrong.kid !== kid, "falscher Schluessel hat andere kid (Vorab-Erkennung)");
    await throws(() => SC.decrypt(wrong.key, env1), "Entschluesseln mit falschem Schluessel wirft");
  }

  // 6) Grosse Nutzlast (deck/history-Groessenordnung) roundtrippt (Base64-Chunking)
  {
    const seed = SC.generateSeed();
    const { key, kid } = await SC.deriveKey(seed);
    const big = { items: Array.from({ length: 5000 }, (_, i) => ({ id: i, s: "x".repeat(40) })) };
    const env = await SC.encrypt(key, kid, big);
    const back = await SC.decrypt(key, env);
    eq(back.items.length, 5000, "grosse Nutzlast roundtrippt (5000 items)");
  }

  // 7) QR-Fragment: buildSyncUrl / parseSyncFragment / consumeSyncFragment
  {
    const seed = SC.generateSeed();
    const code = SC.seedToCode(seed);
    const url = SC.buildSyncUrl("https://jobreif.de", code);
    assert(url === `https://jobreif.de/#sync=v1.${code}`, "buildSyncUrl: Seed im Fragment");
    eq(SC.parseSyncFragment(new URL(url).hash), code, "parseSyncFragment aus URL-hash");
    eq(SC.parseSyncFragment("#sync=v1." + SC.formatCode(code)), code, "parseSyncFragment toleriert gruppiert");
    eq(SC.parseSyncFragment("#foo=bar"), null, "Fremd-Fragment → null");
    eq(SC.parseSyncFragment("#sync=v2." + code), null, "falsche Fragment-Version → null");
    eq(SC.parseSyncFragment("#sync=v1.NICHTVALIDE"), null, "ungueltiger Code im Fragment → null");

    // consumeSyncFragment: Code gespeichert + Fragment aus URL entfernt (Kern-Abnahme F1)
    const store = new Map();
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    let replacedTo = "SENTINEL";
    const history = { replaceState: (_s, _t, u) => { replacedTo = u; } };
    const location = { hash: "#sync=v1." + code, pathname: "/", search: "" };
    const consumed = SC.consumeSyncFragment({ location, history, storage });
    eq(consumed, code, "consumeSyncFragment liefert den Code");
    eq(store.get(SC.SYNC_KEY_STORAGE), code, "Code in localStorage gespeichert");
    eq(replacedTo, "/", "Fragment via replaceState aus URL entfernt");
    // Query bleibt erhalten, Fragment weg
    const loc2 = { hash: "#sync=v1." + code, pathname: "/app", search: "?a=1" };
    SC.consumeSyncFragment({ location: loc2, history, storage });
    eq(replacedTo, "/app?a=1", "Pfad + Query bleiben erhalten, nur Fragment weg");
    // Kein Fragment → null, kein Schreiben
    eq(SC.consumeSyncFragment({ location: { hash: "" }, history, storage }), null, "kein Fragment → null");

    // storedCode / storeCode / clearStoredCode
    eq(SC.storedCode(storage), code, "storedCode liest kanonisch");
    SC.clearStoredCode(storage);
    eq(SC.storedCode(storage), null, "clearStoredCode entfernt");
  }

  console.log(failures === 0 ? "\nALLE TESTS OK" : `\n${failures} FEHLER`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
