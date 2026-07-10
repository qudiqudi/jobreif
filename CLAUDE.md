# jobreif — Regeln für Änderungen an diesem Repo

Dies ist die **öffentliche PWA** von [jobreif.de](https://jobreif.de): ein Einstellungstest-Simulator,
der ohne Build-Schritt im Browser läuft und offline funktioniert. Das Repo ist deployt und hat aktive
Nutzer. Zwei Rahmenbedingungen prägen jede Änderung:

- **Keine Breaking Changes.** Weder an gespeicherten Nutzerdaten noch an etablierten Bedienflüssen.
- **Das Repo ist öffentlich und wird als Ganzes ausgeliefert.** Was hier committet wird, ist auf
  github.com und potenziell auf der Produktionsdomain lesbar.

## Öffentliches Repo: keine Interna

Das gehostete Backend liegt in einem separaten, **nicht-öffentlichen** Repository. Namen seiner
Bausteine, Quelldateien, Env-Variablen und Secrets gehören nicht in dieses Repo — nicht in Code,
Kommentare, Doku, generierte Seiten, Commit-Messages oder PR-Beschreibungen. Eine Commit-Message ist
so öffentlich wie der Code.

Zwei CI-Wächter setzen das durch: `.github/scripts/check-no-internals.js` (bekannte Interna-Begriffe)
und `.github/scripts/check-no-foreign-js.js` (jeder erwähnte `.js`/`.mjs`-Name muss im Repo existieren
oder auf einer begründeten Ausnahmeliste stehen). Sie ersetzen kein Nachdenken, sondern fangen das
Versehen.

Über Client-Interna hinaus verrät der ausgelieferte Code nichts über die Backend-Architektur: Der
Moat liegt im privaten Repo, nicht in offengelegten Endpoints, Schemas oder Prompt-Strategien.

## Gespeicherte Nutzerdaten (localStorage) sind Produktivdaten

- `bewerbungstool.settings` — `{ provider, apiKey, model, tier }`
- `bewerbungstool.history` — `{ jobs: [{ key, titel, jobText, attempts: [...] }] }`

Der `bewerbungstool.`-Präfix ist historisch (Altname des Projekts) und **bleibt** — er ist Teil des
Vertrags mit bestehenden Browsern.

`provider: "hosted"` ist der Default: Das Tool läuft über einen eigenen Cloudflare Worker und braucht
keinen Nutzer-Key. BYOK (anthropic/openai/deepseek) und `local` bleiben als Fallback (Einstellungen →
„Anbieter"). `tier` ist die im Hosted-Modus gewählte Qualitätsstufe (standard/günstig; „beste" hinter
der Paywall). **Alte Keys nie löschen** — sie sind die Credentials des BYOK-Fallbacks.

Regeln für alle gespeicherten Formate:

- Nur abwärtskompatibel erweitern: neue Felder optional; bestehende Felder nie umbenennen oder
  entfernen; Storage-Keys nie ändern.
- Defensiv lesen: Rendering muss alte Einträge tolerieren (Felder aus älteren Versionen können fehlen).
  Nie blind auf neue Felder zugreifen.
- Ist ein Formatwechsel unvermeidbar: Migration beim Laden, alte Daten nie verwerfen.

## Client, Backend und der API-Vertrag

Nur die PWA lebt und deployt aus diesem Repo. Backend- und Prompt-Änderungen gehören ins private
Repository, nicht hierher.

Die Prompts in `app.js` gehören zum BYOK-Pfad; sie stehen für sich und werden nicht mit der Serverseite
abgeglichen. Der **API-Vertrag** dagegen ist bindend: Die `/api/*`- und `/auth/*`-Endpoints, die `app.js`
aufruft, müssen abwärtskompatibel bleiben — die ausgelieferte PWA hängt daran. Schema-Erweiterungen für
die Fragengenerierung passieren serverseitig; gespeicherte Versuche können Quiz-Objekte im alten Schema
enthalten, der Anzeige-Code muss damit umgehen (defensiv lesen). BYOK-Provider-Defaults im UI
(Anbieterauswahl/Modelle) nicht ohne Begründung ändern.

## UI und Flows

- Etablierte Bedienflüsse (Onboarding, URL/Text-Tabs, Lern-/Prüfungsmodus, Auflösen, Historie, Review
  ohne erneute Bewertung) nicht entfernen oder grundlegend umbauen, ohne dass der Nutzer es ausdrücklich
  verlangt.
- **Aktionen mit API-Kosten dürfen nie unbeabsichtigt auslösbar sein** (Vorbild: Der Review-Modus
  bewertet nicht erneut).
- Mobile-Tauglichkeit (≤ 600 px) bei jeder UI-Änderung mitprüfen.

## Deployment

**Versionierung.** Bei nutzersichtbaren Änderungen die Version an drei Stellen erhöhen: die `VERSION`-
Datei, `APP_VERSION` in `app.js` und ein neuer, oberster `CHANGELOG`-Eintrag in `app.js`. Der CI-Check
erzwingt, dass alle drei übereinstimmen. Reine Interna (Doku, CI, Refactoring ohne sichtbare Wirkung)
brauchen keinen Bump.

**Changelog-Ebenen.** Der In-App-`CHANGELOG` („Was ist neu") führt nur nutzerrelevante Highlights —
Features und sichtbare Fixes, kein iteratives Plumbing. Der vollständige Verlauf liegt in den
GitHub-Releases (Link unten im Fenster). Pro Version daher zusätzlich ein Release anlegen:

    gh release create vX.Y.Z --target <commit> --title "Version X.Y.Z (TT.MM.JJJJ)" --notes-file <datei>

Tag-Schema `vX.Y.Z`; das jüngste Release ist automatisch „Latest".

**Merge und Deploy.** `main` ist per Ruleset geschützt — Änderungen laufen über Feature-Branch und PR,
der CI-Check muss grün sein, direkte Pushes sind blockiert. Ein Merge auf `main` löst den Pages-Deploy
aus (`.github/workflows/deploy.yml`); die CI läuft davor erneut. Die Action ersetzt den Platzhalter
`__BUILD__` in `sw.js` durch den Commit-Hash (Cache-Version) — **den Platzhalter nie entfernen**.

**Lokal testen.** UI-Flows im Browser durchklicken; der Zustand lässt sich über die globalen Variablen
`quiz` / `answers` / `mode` / `revealed` in der Konsole injizieren. Einen lokalen Testserver nur auf
Loopback und selbstbegrenzend starten, danach den Port prüfen:

    timeout 900 python3 -m http.server 8765 --bind 127.0.0.1 & SRV=$!
    # ... testen ...
    kill $SRV

Ohne `--bind 127.0.0.1` lauscht `http.server` auf allen Interfaces und liefert das Arbeitsverzeichnis
ins Netz; `timeout` beendet einen vergessenen Server von selbst.

**Deploy verifizieren.** `gh run watch`, oder mit Cache-Buster prüfen, dass der ausgelieferte
Service-Worker den Commit-Hash trägt statt des Platzhalters:

    curl -s "https://jobreif.de/sw.js?t=$RANDOM" | grep bewerbungstool-
