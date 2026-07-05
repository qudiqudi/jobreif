"use strict";

// Geraete-Sync (Option B) — Krypto-Layer, oeffentlich und bewusst nachpruefbar.
//
// Dieser Client-Code ist absichtlich Teil der public PWA (AGPL): die Ende-zu-Ende-
// Verschluesselung soll auditierbar sein. Der Server (api.jobreif.de) sieht ausschliesslich
// Chiffrate; der Schluessel existiert nur hier, auf den Geraeten des Nutzers.
//
// Ablauf:
//   Seed (128 bit Zufall)  ──HKDF-SHA-256(info="jobreif-sync-v1")──▶  AES-256-GCM-Datenschluessel
//   Der Seed wird als Crockford-Base32 „Sync-Code" abgetippt/als QR gescannt. Aus dem Datenschluessel
//   folgt eine kurze Key-ID (kid) zur „falscher Schluessel"-Erkennung. Pro Kind wird ein Envelope
//   { v, kid, iv, ct } gespeichert; Klartext im ct ist das JSON des Kinds (opak fuer den Server).
//
// Schluesselverlust ist unkritisch (local-first): „Sync zuruecksetzen" = neuer Seed, Re-Upload.
// Es gibt bewusst KEIN Passphrase-/Recovery-System.
//
// UMD: laeuft als klassisches <script> (setzt window.SyncCrypto) und ist zugleich per require()
// testbar (module.exports). WebCrypto kommt aus globalThis.crypto (Browser wie Node >=18).

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.SyncCrypto = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this), function () {

  const C = (typeof globalThis !== "undefined" && globalThis.crypto) ? globalThis.crypto : crypto;
  const TE = new TextEncoder();
  const TD = new TextDecoder();

  // --- Konstanten (festgelegt, nicht variieren — sonst kollidieren Alt-Geraete) -------------
  const HKDF_INFO = "jobreif-sync-v1";
  const SEED_BYTES = 16;                 // 128 bit
  const IV_BYTES = 12;                   // AES-GCM-Nonce
  const SYNC_KEY_STORAGE = "bewerbungstool.syncKey";
  const FRAGMENT_VERSION = "v1";         // #sync=v1.<code>
  // Crockford-Base32 (ohne I, L, O, U — verwechslungsarm). 32 Symbole → 5 bit je Zeichen.
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const CODE_LEN = 26;                    // ceil(128/5) Zeichen fuer 16 Byte

  // Dekodier-Tabelle mit Crockford-Nachsicht: Klein/gross gleich, I/L→1, O→0.
  const DECODE = (() => {
    const m = Object.create(null);
    for (let i = 0; i < CROCKFORD.length; i++) { m[CROCKFORD[i]] = i; m[CROCKFORD[i].toLowerCase()] = i; }
    m["I"] = m["i"] = m["L"] = m["l"] = 1;
    m["O"] = m["o"] = 0;
    return m;
  })();

  // --- Base64 (chunk-sicher, auch fuer grosse Chiffrate wie deck/history) --------------------
  function bytesToB64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function b64ToBytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // --- Seed / Sync-Code ---------------------------------------------------------------------

  function generateSeed() {
    return C.getRandomValues(new Uint8Array(SEED_BYTES));
  }

  // 16 Byte → 26 Crockford-Zeichen (kanonisch, ungruppiert, Grossbuchstaben). Bit-Akkumulator
  // mit Maskierung, damit `value` nie ueber ~13 bit waechst (kein 32-bit-Overflow bei 16 Byte).
  function seedToCode(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== SEED_BYTES) {
      throw new Error("seed: genau " + SEED_BYTES + " Byte erwartet");
    }
    let bits = 0, value = 0, out = "";
    for (let i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) { out += CROCKFORD[(value >>> (bits - 5)) & 31]; bits -= 5; value &= (1 << bits) - 1; }
    }
    if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
    return out;
  }

  // Sync-Code (beliebige Schreibweise: Klein/gross, Bindestriche/Leerzeichen egal, Crockford-
  // Nachsicht) → 16 Byte. Wirft bei ungueltigem Zeichen oder falscher Laenge.
  function codeToSeed(code) {
    if (typeof code !== "string") throw new Error("sync-code: kein String");
    const clean = code.replace(/[\s-]/g, "");
    if (clean.length !== CODE_LEN) throw new Error("sync-code: falsche Laenge");
    let bits = 0, value = 0;
    const out = [];
    for (let i = 0; i < clean.length; i++) {
      const v = DECODE[clean[i]];
      if (v === undefined) throw new Error("sync-code: ungueltiges Zeichen");
      value = (value << 5) | v;
      bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; value &= (1 << bits) - 1; }
    }
    // 26*5=130 bit → 16 Byte + 2 Padding-bit. Kanonisch codierte Codes (seedToCode) haben diese
    // Padding-bit = 0. Nicht-Null-Padding ablehnen: erzwingt eine echte Bijektion Seed↔Code und
    // erhaelt die Tippfehler-Erkennung im letzten Zeichen (Codex-Adversarial-Finding).
    if (bits > 0 && value !== 0) throw new Error("sync-code: nicht-kanonische Padding-Bits");
    return Uint8Array.from(out);
  }

  // Anzeige-Form: XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX (5-5-5-5-6).
  function formatCode(code) {
    const c = String(code).replace(/[\s-]/g, "").toUpperCase();
    return c.replace(/(.{5})(.{5})(.{5})(.{5})(.{1,6})/, "$1-$2-$3-$4-$5");
  }

  // Toleranter Normalisierer fuer die Code-Eingabe: gueltig → kanonischer 26-Zeichen-Code,
  // sonst null. (Validiert ueber den echten Decode-Pfad.)
  function normalizeCode(code) {
    try { return seedToCode(codeToSeed(code)); } catch { return null; }
  }

  // --- Schluessel-Ableitung + Key-ID --------------------------------------------------------

  // Seed → { key: AES-256-GCM (nicht extrahierbar), kid: 8 Hex }. HKDF liefert erst die 256 rohen
  // Bit; daraus SOWOHL der AES-Schluessel ALS AUCH die kid (SHA-256 der Rohbytes, erste 4 Byte).
  // So bleibt der AES-Schluessel non-extractable und die kid ist trotzdem berechenbar.
  async function deriveKey(seed) {
    const seedBytes = seed instanceof Uint8Array ? seed : codeToSeed(seed);
    // Invariante 128-bit-Seed fail-closed erzwingen: ein Seed falscher Laenge (Bug/Import)
    // darf keinen Schluessel aus einem unbeabsichtigten Keyspace ableiten (Codex-Finding).
    if (!(seedBytes instanceof Uint8Array) || seedBytes.length !== SEED_BYTES) {
      throw new Error("seed: genau " + SEED_BYTES + " Byte erwartet");
    }
    const base = await C.subtle.importKey("raw", seedBytes, "HKDF", false, ["deriveBits"]);
    const bits = await C.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: TE.encode(HKDF_INFO) },
      base, 256
    );
    const raw = new Uint8Array(bits);
    const key = await C.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    const digest = new Uint8Array(await C.subtle.digest("SHA-256", raw));
    const kid = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { key, kid };
  }

  // --- Envelope (das, was zum Server geht) --------------------------------------------------

  // Klartext-Objekt → { v:1, kid, iv, ct }. Frische 12-Byte-IV pro Write (Pflicht bei GCM).
  async function encrypt(key, kid, obj) {
    const iv = C.getRandomValues(new Uint8Array(IV_BYTES));
    const pt = TE.encode(JSON.stringify(obj));
    const ct = new Uint8Array(await C.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
    return { v: 1, kid, iv: bytesToB64(iv), ct: bytesToB64(ct) };
  }

  // Envelope → Klartext-Objekt. Wirft bei GCM-Auth-Fehler (falscher Schluessel/manipuliert) —
  // der Aufrufer prueft vorher die kid, damit ein bekannter Schluesselwechsel ohne Wurf greift.
  async function decrypt(key, env) {
    const pt = await C.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.ct));
    return JSON.parse(TD.decode(pt));
  }

  // Form-Vorfilter (der Server validiert autoritativ): v:1, kid=8hex, iv=Base64 von 12 Byte
  // (16 Zeichen, ohne Padding), ct=nicht-leeres Base64. Inhalte bleiben opak.
  function isEnvelope(e) {
    return !!e && typeof e === "object" && e.v === 1
      && typeof e.kid === "string" && /^[0-9a-f]{8}$/.test(e.kid)
      && typeof e.iv === "string" && /^[A-Za-z0-9+/]{16}$/.test(e.iv)
      && typeof e.ct === "string" && /^[A-Za-z0-9+/]{4,}={0,2}$/.test(e.ct);
  }

  // --- QR-/Fragment-Kopplung ----------------------------------------------------------------

  // Kopplungs-URL fuer QR: der Seed steht im FRAGMENT (erreicht den Server nie). Ungruppierter
  // Code, damit der QR kompakt bleibt.
  function buildSyncUrl(origin, code) {
    const canon = seedToCode(codeToSeed(code));
    return `${String(origin).replace(/\/+$/, "")}/#sync=${FRAGMENT_VERSION}.${canon}`;
  }

  // location.hash (oder eine Fragment-Zeichenkette) → kanonischer Code oder null. Erwartet
  // `sync=v1.<code>`; validiert den Code ueber den echten Decode-Pfad.
  function parseSyncFragment(hash) {
    if (typeof hash !== "string") return null;
    const frag = hash.replace(/^#/, "");
    const m = frag.match(/(?:^|&)sync=([^&]+)/);
    if (!m) return null;
    const val = m[1];
    const dot = val.indexOf(".");
    if (dot < 0 || val.slice(0, dot) !== FRAGMENT_VERSION) return null;
    return normalizeCode(val.slice(dot + 1));
  }

  // Beim App-Start: Fragment lesen → Code speichern → Fragment SOFORT aus URL/History entfernen
  // (history.replaceState), damit der Seed nicht in der Adressleiste/History haengen bleibt.
  // Dependencies injizierbar (testbar). Rueckgabe: uebernommener Code oder null.
  function consumeSyncFragment(deps) {
    const location = (deps && deps.location) || (typeof window !== "undefined" ? window.location : null);
    const history = (deps && deps.history) || (typeof window !== "undefined" ? window.history : null);
    const storage = (deps && deps.storage) || (typeof window !== "undefined" ? window.localStorage : null);
    if (!location || typeof location.hash !== "string") return null;
    const code = parseSyncFragment(location.hash);
    if (!code) return null;
    // Seed sichern — aber das Fragment MUSS auch dann aus URL/History verschwinden, wenn das
    // Speichern scheitert (Privatmodus/Quota/Storage deaktiviert → setItem wirft). Sonst bliebe
    // der Seed in der Adressleiste/History sichtbar (Codex-Adversarial-Finding). Daher store in
    // try/catch, der replaceState-Strip laeuft unabhaengig.
    try { if (storage) storage.setItem(SYNC_KEY_STORAGE, code); } catch { /* Strip trotzdem */ }
    if (history && typeof history.replaceState === "function") {
      const rest = (location.pathname || "/") + (location.search || "");
      try { history.replaceState(null, "", rest); } catch { /* best effort */ }
    }
    return code;
  }

  // --- localStorage-Helfer ------------------------------------------------------------------
  function storedCode(storage) {
    const s = storage || (typeof window !== "undefined" ? window.localStorage : null);
    if (!s) return null;
    const v = s.getItem(SYNC_KEY_STORAGE);
    return v ? normalizeCode(v) : null;
  }
  function storeCode(code, storage) {
    const s = storage || (typeof window !== "undefined" ? window.localStorage : null);
    const canon = seedToCode(codeToSeed(code)); // validiert + kanonisiert
    if (s) s.setItem(SYNC_KEY_STORAGE, canon);
    return canon;
  }
  function clearStoredCode(storage) {
    const s = storage || (typeof window !== "undefined" ? window.localStorage : null);
    if (s) s.removeItem(SYNC_KEY_STORAGE);
  }

  return {
    SYNC_KEY_STORAGE, FRAGMENT_VERSION, CODE_LEN, HKDF_INFO,
    generateSeed, seedToCode, codeToSeed, formatCode, normalizeCode,
    deriveKey, encrypt, decrypt, isEnvelope,
    buildSyncUrl, parseSyncFragment, consumeSyncFragment,
    storedCode, storeCode, clearStoredCode,
  };
});
