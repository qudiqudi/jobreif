#!/usr/bin/env node
// IndexNow-Ping (dependency-frei) — Gegenstück zum GSC-Submit (scripts/gsc-submit.mjs).
//
// IndexNow ist ein offenes Protokoll, mit dem eine Website teilnehmende
// Suchmaschinen (Bing, Yandex, Seznam u. a.) sofort über neue/geänderte URLs
// informiert, statt auf den nächsten Crawl zu warten. Google beteiligt sich
// NICHT an IndexNow — für Google übernimmt der GSC-Submit im selben CI-Job.
//
// Auth: KEIN OAuth, KEIN Secret. Der Key unten ist ABSICHTLICH öffentlich —
// die Domain-Kontrolle wird dadurch bewiesen, dass die Keyfile
// https://jobreif.de/<KEY>.txt öffentlich erreichbar ist und genau den Key
// enthält. Mehr als URLs der eigenen Domain melden kann man damit nicht.
//
// Läuft in CI nach dem Pages-Deploy (Job submit-sitemap in
// .github/workflows/deploy.yml), wenn sich sitemap.xml geändert hat.
//
// Verhalten:
//   - Keyfile fehlt oder weicht vom Key ab -> exit 1 (Konfig-Drift, sichtbar)
//   - HTTP 200/202                         -> exit 0 (Erfolg)
//   - 4xx (403 Key ungültig, 422 URLs)     -> exit 1 (Konfig-Fehler, sichtbar)
//   - Netzwerk/5xx nach Retries            -> Warnung, exit 0 (best-effort:
//     ein Ping darf den Deploy nicht dauerhaft rot machen)
//   - INDEXNOW_DRY_RUN=1                   -> alles prüfen und bauen, aber
//     NICHTS senden; exit 0
//
// Lauf lokal (vom Repo-Root, ohne zu senden):
//   INDEXNOW_DRY_RUN=1 node scripts/indexnow-ping.mjs

import { readFile } from "node:fs/promises";

const KEY = "1c829db604299e71987bc73278b31001";
const HOST = "jobreif.de";
const KEY_LOCATION = `https://jobreif.de/${KEY}.txt`;
// Aggregator-Endpoint: verteilt die Meldung an alle teilnehmenden Engines.
const ENDPOINT = "https://api.indexnow.org/indexnow";
// Pro Versuch: haengende Verbindung nicht ewig offen halten (best-effort).
const TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch mit begrenztem Retry — wiederholt NUR bei Netzwerkfehlern und HTTP 5xx
// (3 Versuche, Backoff 1s/2s). 4xx werden unverändert zurückgegeben, damit der
// Aufrufer sie deuten kann. (Gleiche Struktur wie in scripts/gsc-submit.mjs;
// bewusst dupliziert, die Skripte bleiben eigenständig.)
async function fetchRetry(url, opts, label) {
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let r;
    try {
      // AbortSignal.timeout wirft bei Zeitueberschreitung — wird wie ein
      // Netzwerkfehler behandelt (retry, danach best-effort).
      r = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      if (attempt < ATTEMPTS) {
        console.warn(`${label}: Netzwerkfehler (Versuch ${attempt}/${ATTEMPTS}): ${e.message} — neuer Versuch in ${attempt}s ...`);
        await sleep(attempt * 1000); // Backoff 1s, 2s
        continue;
      }
      throw new Error(`${label} nach ${ATTEMPTS} Versuchen gescheitert (Netzwerk): ${e.message}`);
    }
    if (r.status >= 500 && attempt < ATTEMPTS) {
      console.warn(`${label}: HTTP ${r.status} (Versuch ${attempt}/${ATTEMPTS}) — neuer Versuch in ${attempt}s ...`);
      await sleep(attempt * 1000);
      continue;
    }
    return r;
  }
}

// Konsistenz-Check: Die committete Keyfile im Repo-Root muss exakt den Key
// enthalten — fängt Drift zwischen Konstante und ausgelieferter Datei.
async function checkKeyfile() {
  let raw;
  try {
    raw = await readFile(`./${KEY}.txt`, "utf8");
  } catch (e) {
    console.error(`Keyfile ./${KEY}.txt nicht lesbar (${e.message}) — vom Repo-Root ausführen; die Datei muss committed sein.`);
    process.exit(1);
  }
  if (raw.trim() !== KEY) {
    console.error(`Keyfile ./${KEY}.txt enthält nicht den erwarteten Key — Drift zwischen Skript-Konstante und Keyfile.`);
    process.exit(1);
  }
}

// Einfache XML-Entity-Dekodierung fuer <loc>-Inhalte (Sitemaps escapen z. B. & als &amp;).
// &amp; bewusst ZULETZT, damit z. B. &amp;lt; nicht faelschlich zu < wird.
function decodeEntities(s) {
  const cp = (m, n, radix) => {
    try { return String.fromCodePoint(parseInt(n, radix)); } catch { return m; }
  };
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => cp(m, h, 16))   // hex-numerische Referenz
    .replace(/&#(\d+);/g, (m, d) => cp(m, d, 10))              // dezimal-numerische Referenz
    .replace(/&amp;/g, "&");
}

// Alle <loc>-URLs aus der Sitemap, gefiltert auf den eigenen Host. Liefert die
// Gesamtzahl der <loc>-Eintraege mit, damit der Aufrufer eine kaputte Sitemap
// (Eintraege vorhanden, aber keiner verwertbar) von einer echt leeren unterscheidet.
async function sitemapUrls() {
  let xml;
  try {
    xml = await readFile("./sitemap.xml", "utf8");
  } catch (e) {
    console.error(`sitemap.xml nicht lesbar (${e.message}) — vom Repo-Root ausführen.`);
    process.exit(1);
  }
  // Wohlgeformtheit grob prüfen: jede <loc>-Öffnung muss ein sauberes
  // <loc>…</loc> ergeben. Weichen die Zahlen ab (z. B. fehlendes </loc>),
  // ist die Sitemap kaputt → sichtbar abbrechen statt still nichts zu melden.
  const opened = (xml.match(/<loc>/g) || []).length;
  const matches = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)];
  if (opened !== matches.length) {
    console.error(`sitemap.xml wirkt kaputt: ${opened} <loc>-Öffnungen, aber ${matches.length} wohlgeformte <loc>…</loc> — Abbruch.`);
    process.exit(1);
  }
  const urls = [];
  for (const m of matches) {
    try {
      const u = new URL(decodeEntities(m[1].trim()));
      if (u.hostname === HOST) urls.push(u.href);
    } catch {
      // kaputte URL: wird unten ueber die Differenz zu matches.length erkannt
    }
  }
  return { urls, total: matches.length };
}

async function main() {
  await checkKeyfile();
  const { urls: urlList, total } = await sitemapUrls(); // total = wohlgeformte <loc>-Einträge
  if (total === 0) {
    console.warn("sitemap.xml enthält keine <loc>-Einträge — nichts zu melden.");
    return; // exit 0
  }
  if (urlList.length !== total) {
    // Invariante: JEDER wohlgeformte <loc> muss eine gültige eigene URL sein.
    // Weicht das ab (fremder Host / kaputte URL), ist die Sitemap faul → sichtbar abbrechen.
    console.error(`sitemap.xml: ${total} <loc>-Einträge, aber nur ${urlList.length} gültige ${HOST}-URLs — vermutlich kaputt oder Host gewechselt. Abbruch.`);
    process.exit(1);
  }
  const payload = { host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList };
  if (process.env.INDEXNOW_DRY_RUN === "1") {
    console.log(`Trockenlauf: Keyfile ok, Payload mit ${urlList.length} URLs gebaut — es wird NICHT gesendet.`);
    return; // exit 0
  }
  let r;
  try {
    r = await fetchRetry(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, "IndexNow-Ping");
  } catch (e) {
    console.warn(`${e.message} — best-effort, Deploy bleibt grün.`);
    return; // exit 0
  }
  if (r.status === 200 || r.status === 202) {
    console.log(`IndexNow-Ping erfolgreich (HTTP ${r.status}): ${urlList.length} URLs gemeldet.`);
    return;
  }
  if (r.status >= 400 && r.status < 500) {
    const hint = r.status === 403
      ? "Key/Keyfile nicht valide — ist die Keyfile unter " + KEY_LOCATION + " erreichbar?"
      : r.status === 422
        ? "gemeldete URLs gehören nicht zum Host " + HOST
        : "Client-Fehler";
    console.error(`IndexNow-Ping abgelehnt: HTTP ${r.status} (${hint}).`);
    process.exit(1);
  }
  console.warn(`IndexNow-Ping: HTTP ${r.status} nach Retries — best-effort, Deploy bleibt grün.`);
}

main();
