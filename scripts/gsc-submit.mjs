#!/usr/bin/env node
// GSC-Sitemap-Submit (Schreibzugriff, dependency-frei) — Gegenstück zum
// read-only gsc-status.mjs (lokal, bewusst ungetrackt).
//
// Reicht die Sitemap per Search-Console-API neu ein (PUT sitemaps/<feedpath>),
// damit Google sie nach Änderungen zeitnah neu lädt. Läuft in CI nach dem
// Pages-Deploy (Job submit-sitemap in .github/workflows/deploy.yml).
//
// One-Time-Setup (einmalig, vom Betreiber — NICHT in CI):
//   1. Refresh-Token mit SCHREIB-Scope holen. Entweder über gcloud-ADC:
//        gcloud auth application-default login --no-launch-browser \
//          --scopes=https://www.googleapis.com/auth/webmasters,https://www.googleapis.com/auth/cloud-platform
//      und anschließend aus ~/.config/gcloud/application_default_credentials.json
//      die Felder client_id, client_secret und refresh_token entnehmen.
//      ODER über einen eigenen OAuth-Client (GCP-Konsole -> APIs & Dienste ->
//      Anmeldedaten -> OAuth-Client-ID, Typ "Desktop-App"): den
//      Authorization-Code-Flow einmal mit Scope
//      https://www.googleapis.com/auth/webmasters durchlaufen und das
//      erhaltene refresh_token sichern.
//      Wichtig: der Scope muss "webmasters" (schreibend) sein —
//      "webmasters.readonly" reicht fürs Einreichen NICHT.
//   2. Als GitHub-Actions-Secrets in diesem Repo hinterlegen:
//        GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN   (Pflicht)
//      Optional (nur falls vom Default abweichend):
//        GSC_SITE           Default: sc-domain:jobreif.de
//        GSC_SITEMAP        Default: https://jobreif.de/sitemap.xml
//        GSC_QUOTA_PROJECT  Default: jobreif-gsc
//
// Verhalten:
//   - Pflicht-Secrets fehlen  -> sauberes No-op, exit 0 (CI bleibt grün).
//   - Erfolg (HTTP 200/204)   -> exit 0, danach Best-effort-Verifikation per GET.
//   - Endgültiger Fehler      -> exit 1 (CI sichtbar rot).
//   - Secrets (client_secret, refresh_token, access_token) erscheinen NIE in
//     der Ausgabe.
//
// Lauf lokal:  GSC_CLIENT_ID=... GSC_CLIENT_SECRET=... GSC_REFRESH_TOKEN=... \
//              node scripts/gsc-submit.mjs

const missing = ["GSC_CLIENT_ID", "GSC_CLIENT_SECRET", "GSC_REFRESH_TOKEN"]
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.log("GSC-Submit übersprungen – keine Credentials konfiguriert.");
  process.exit(0);
}

const SITE = process.env.GSC_SITE || "sc-domain:jobreif.de";
const SITEMAP = process.env.GSC_SITEMAP || "https://jobreif.de/sitemap.xml";
const QUOTA_PROJECT = process.env.GSC_QUOTA_PROJECT || "jobreif-gsc";

// siteUrl enthält ':' (sc-domain:...), feedpath ist eine volle URL — beide
// MÜSSEN encodeURIComponent-kodiert ins Pfadsegment.
const SITEMAP_API_URL = "https://www.googleapis.com/webmasters/v3/sites/"
  + `${encodeURIComponent(SITE)}/sitemaps/${encodeURIComponent(SITEMAP)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch mit begrenztem Retry — wiederholt NUR bei Netzwerkfehlern und HTTP 5xx
// (3 Versuche, Backoff 1s/2s). 4xx werden unveraendert zurueckgegeben, damit der
// Aufrufer sie deuten kann. Gemeinsam genutzt von Token-Refresh und Submit, damit
// ein einzelner transienter Fehler den CI-Lauf nicht faelschlich rot macht.
async function fetchRetry(url, opts, label) {
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let r;
    try {
      r = await fetch(url, opts);
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

async function accessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GSC_CLIENT_ID,
    client_secret: process.env.GSC_CLIENT_SECRET,
    refresh_token: process.env.GSC_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const r = await fetchRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }, "Token-Refresh");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Bewusst nur Status + Fehlercode loggen — nie den Request-Body oder die
    // Antwort komplett (Secret-Hygiene).
    throw new Error(`Token-Refresh fehlgeschlagen: ${r.status} ${j.error || ""}`.trim());
  }
  return j.access_token;
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, "x-goog-user-project": QUOTA_PROJECT };
}

async function submit(token) {
  const r = await fetchRetry(SITEMAP_API_URL, { method: "PUT", headers: authHeaders(token) }, "Submit");
  if (r.status === 200 || r.status === 204) {
    console.log(`Sitemap eingereicht: ${SITEMAP} für ${SITE} (HTTP ${r.status})`);
    return;
  }
  if (r.status === 401 || r.status === 403) {
    throw new Error(`HTTP ${r.status}: Schreib-Scope (webmasters) fehlt oder das Konto hat keinen Zugriff auf die Property ${SITE}.`);
  }
  const text = await r.text().catch(() => "");
  throw new Error(`Submit fehlgeschlagen: HTTP ${r.status} ${text.slice(0, 300)}`);
}

// Best effort: Status der eingereichten Sitemap abfragen und loggen.
// Fehler hier sind nur Warnungen — der Submit selbst war schon erfolgreich.
async function verify(token) {
  try {
    const r = await fetch(SITEMAP_API_URL, { headers: authHeaders(token) });
    if (!r.ok) {
      console.warn(`Verifikation nicht möglich: HTTP ${r.status}`);
      return;
    }
    const j = await r.json();
    const n = (j.contents || []).reduce((a, c) => a + Number(c.submitted || 0), 0);
    console.log(`Verifikation: eingereicht=${n} URLs, zuletzt geladen=${j.lastDownloaded || "—"}, Fehler=${j.errors || 0}, Warnungen=${j.warnings || 0}`);
  } catch (e) {
    console.warn(`Verifikation nicht möglich: ${e.message}`);
  }
}

async function main() {
  const token = await accessToken();
  await submit(token);
  await verify(token);
}

main().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
