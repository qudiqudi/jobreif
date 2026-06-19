# Plan – Issue #3: Bessere URL-Extraktion über JSON-LD (JobPosting)

## Ziel
Die Qualität des URL-Imports von Stellenanzeigen verbessern, ohne neue Infrastruktur-
Kosten und ohne UX/UI-Bruch. Rein additiv in `app.js`, keine Worker-Änderungen.

## Ausgangslage
- URL-Import ist vollständig clientseitig (`fetchJobFromUrl`, ~Zeile 2139).
- Proxy über `r.jina.ai` (Free-Tier, offene CORS-Header), Standard-Modus liefert Markdown.
- Vorhandene Bausteine bleiben unangetastet: `candidateUrls` (Portal-Rewrites),
  `cleanPageText`, `cleanLinkedIn`, `looksBlocked`, `looksLikeRealContent`.
- Schwächen: Indeed (Cloudflare-Bot-Wall), reine JS-SPAs.

## Kernidee
Fast jedes Jobportal bettet einen schema.org-`JobPosting`-JSON-LD-Block ein (Google Jobs
verlangt ihn). Jinas Markdown-Modus verwirft ihn. Wenn wir stattdessen das rohe HTML
anfordern (`x-respond-with: html`, gleicher Endpoint, gleicher Free-Tier, gleiches CORS),
können wir den Block mit dem browser-nativen `DOMParser` lesen und portalunabhängig
sauberen Text bauen.

## Geschichtete Strategie in `fetchJobFromUrl`

### Layer 1 (neu, primär): JSON-LD aus HTML
1. Für die Original-URL (und ggf. die erste Rewrite-Kandidaten-URL) das rohe HTML holen:
   `fetch("https://r.jina.ai/" + u, { headers: { "x-respond-with": "html" } })`.
2. `new DOMParser().parseFromString(html, "text/html")`.
3. Alle `script[type="application/ld+json"]` einsammeln.
4. Jeden Block tolerant per `JSON.parse` lesen (try/catch einzeln, ein kaputter Block darf
   die anderen nicht killen).
5. Kandidaten flach ziehen: direktes Objekt, Array, und `@graph`-Container.
6. Objekt finden, dessen `@type` `JobPosting` ist oder enthält (String oder Array).
7. Sauberen Text zusammensetzen aus:
   - `title`
   - `hiringOrganization.name` (Objekt oder String defensiv)
   - `jobLocation` -> `address` (`addressLocality`, `addressRegion`, `addressCountry`),
     auch Array von Locations
   - `employmentType` (String oder Array)
   - `baseSalary` (value/minValue/maxValue + currency + unitText), defensiv
   - `description` -> HTML strippen (über ein DOMParser-Dokument, `textContent`,
     Whitespace normalisieren)
8. Nur zurückgeben, wenn der zusammengebaute Text plausibel ist (Mindestlänge der
   Beschreibung), sonst weiter zu Layer 2.

### Layer 2 (Fallback, unverändert): bisheriger Markdown-Pfad
`candidateUrls` + Jina-Markdown + `cleanPageText`/`cleanLinkedIn` +
`looksBlocked`/`looksLikeRealContent`. Exakt wie heute, greift wenn kein brauchbares
JobPosting-JSON-LD gefunden wurde.

Readability (Layer 2.5) wird bewusst NICHT eingebaut: zusätzliche Bundle-Kosten,
kein klarer Gewinn neben JSON-LD + bestehendem Markdown-Pfad. Diff klein halten.

### Layer 3 (unverändert): manuelles Einfügen / Teilinhalt-Warnung
Bleibt der finale Fallback.

## Reihenfolge / Robustheit
- Layer 1 ist best-effort: jeder Fehler (Netzwerk, Header-Verhalten, leeres/kaputtes
  HTML, kein JobPosting) führt zum stillen Fallback auf Layer 2 — kein neuer harter
  Fehlerpfad, kein Regressionsrisiko für bestehende Flows.
- Layer 1 fügt pro Import wenige zusätzliche Jina-Requests hinzu (Original-URL und evtl.
  erste Rewrite-Kandidaten-URL). Free-Tier, kein Projektkostenrisiko.
- LinkedIn-Sonderfall: findet Layer 1 nichts, greift wie gehabt `cleanLinkedIn` im
  Markdown-Pfad. Kein Bruch.

## Sanitizing-Details
- `JobPosting`-Erkennung: `@type` kann String oder Array sein -> beides prüfen, case-
  insensitiv.
- Mehrere JobPosting-Blöcke: den mit brauchbarster (längster) Beschreibung nehmen.
- HTML-in-`description`: über DOMParser zu Text, Entities werden korrekt aufgelöst.
- Alle Feldzugriffe defensiv (Felder können fehlen/anders typisiert sein).
- Kein `innerHTML`/kein Einfügen ins Live-DOM — DOMParser erzeugt ein totes Dokument,
  Skripte laufen nicht. Kein XSS/CSP-Problem.

## Test
- `node --check app.js` muss grün sein.
- Kleines lokales Harness: die reine Parse-/Assemble-Logik gegen mehrere
  Beispiel-JSON-LD-Strings prüfen (einfacher JobPosting, `@graph`-verschachtelt,
  `@type`-Array, HTML in description, kaputter Block neben gutem, mehrere JobPostings,
  fehlende Felder). DOMParser fehlt im Node-Harness -> die JSON-LD-Auswahl + den Textbau
  so kapseln, dass sie ohne DOM testbar sind; den HTML-Strip in eine kleine, injizierbare
  Hilfsfunktion fassen. Live-Portale sind von hier nicht erreichbar -> im Report ehrlich
  als unverifiziert markieren.
- Manuelles UI-Smoke (lokaler Server) soweit ohne Live-Portale möglich.

## Versionierung (user-sichtbar)
- `VERSION`: 1.8.4 -> 1.8.5
- `app.js` `APP_VERSION`: 1.8.5
- Neuer `CHANGELOG`-Eintrag oben, nutzer-relevantes Highlight (zuverlässigere Übernahme
  von Stellenanzeigen per Link), echte Umlaute, keine Emojis.

## Nicht-Ziele
- Kein Worker-Scraping, keine Browser-Rendering-/Paid-API.
- Keine Entfernung/Umbau bestehender Flows, Rewrites, Heuristiken, manuelles Einfügen.
- Keine neuen Storage-Keys, keine Format-Änderung an gespeicherten Daten.
