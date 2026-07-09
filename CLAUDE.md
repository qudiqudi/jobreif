# Bewerbungstool – Regeln für Änderungen

Das Tool ist öffentlich auf GitHub Pages deployt und hat aktive Nutzer. Ab jetzt gilt: keine Breaking Changes. Bei Änderungen, die UX oder Bedienbarkeit betreffen, besonders vorsichtig vorgehen.

## Gespeicherte Nutzerdaten (localStorage) sind Produktivdaten

- `bewerbungstool.settings`: { provider, apiKey, model, tier }
- `bewerbungstool.history`: { jobs: [{ key, titel, jobText, attempts: [...] }] }

Seit 1.1.0 ist `provider: "hosted"` der Default: das Tool läuft über einen eigenen
Cloudflare Worker und braucht keinen Nutzer-Key. BYOK (anthropic/openai/deepseek) und `local`
bleiben als Fallback erhalten (in den Einstellungen unter „Anbieter"), also KEIN Bruch
der keine-Breaking-Changes-Regel. `tier` ist die im Hosted-Modus gewählte Qualitätsstufe
(standard/guenstig; „beste"/Opus hinter der Paywall). Alte Keys nie löschen — sie sind
die Credentials des BYOK-Fallbacks.

Der Hosted-Worker (Endpoints, Premium-Prompts, Budget-Gate, Turnstile, Golden-Set) lebt seit
dem Repo-Split im PRIVATEN Repo `qudiqudi/jobreif-backend` und deployt von dort. Die
Client-Prompts in `app.js` sind die bewusst eingefrorene öffentliche BYOK-Basis und werden
NICHT mehr mit den Server-Prompts synchronisiert (die Premium-Prompts dürfen privat divergieren).
Der API-Vertrag (`/api/generate-quiz`, `/api/jobs`, `/api/evaluate`, `/api/themenfelder`,
`/api/event`, `/api/report`, `/auth/*`) muss abwärtskompatibel bleiben — die ausgelieferte PWA
hängt daran.

Regeln:
- Formate nur abwärtskompatibel erweitern: neue Felder optional, nie bestehende Felder umbenennen oder entfernen, nie die Storage-Keys ändern.
- Rendering muss alte Einträge tolerieren (Felder können fehlen, z. B. Versuche aus älteren Versionen ohne neuere Eigenschaften). Immer defensiv lesen, nie blind auf neue Felder zugreifen.
- Wenn ein Formatwechsel unvermeidbar ist: Migration beim Laden einbauen, alte Daten nie verwerfen.

## UI und Flows

- Etablierte Bedienflüsse (Onboarding, URL/Text-Tabs, Lern-/Prüfungsmodus, Auflösen, Historie, Review ohne erneute Bewertung) nicht entfernen oder grundlegend umbauen, ohne dass der Nutzer das ausdrücklich verlangt.
- Aktionen, die API-Kosten verursachen, dürfen nie unbeabsichtigt auslösbar sein (Vorbild: Review-Modus bewertet nicht erneut).
- Mobile-Tauglichkeit (≤ 600px) bei jeder UI-Änderung mitprüfen.

## Deployment-Ritual

- Bei nutzersichtbaren Änderungen: Version in der `VERSION`-Datei hochzählen und in `app.js` `APP_VERSION` plus einen neuen `CHANGELOG`-Eintrag (oben anfügen) pflegen — der CI-Check erzwingt, dass alle drei übereinstimmen.
- Changelog-Trennung: Der In-App-`CHANGELOG` (Fenster „Was ist neu“) führt nur Highlights, die für nicht-technische Nutzer eine gute Info sind — Features und sichtbare Fixes. Iterative Interna (Local-Model-Tuning, reines Robustheits-/Barrierefreiheits-Plumbing) gehören NICHT hinein. Der vollständige Verlauf liegt in den GitHub-Releases (Link unten im Fenster). Pro Version daher zusätzlich ein GitHub-Release mit den ausführlichen Notizen anlegen: `gh release create vX.Y.Z --target <commit> --title "Version X.Y.Z (TT.MM.JJJJ)" --notes-file <datei>`. Tag-Schema `vX.Y.Z`, das jüngste Release ist automatisch „Latest“.
- main ist per Ruleset geschützt: Änderungen laufen über Feature-Branch und PR, der CI-Check (`.github/workflows/ci.yml`: JS-Syntax, Asset-/Manifest-Integrität, `__BUILD__`-Platzhalter) muss grün sein, dann mergen. Direkte Pushes auf main sind blockiert.
- Deploy läuft über GitHub Actions (`.github/workflows/deploy.yml`): Merge auf main genügt, die CI-Checks laufen vor dem Deploy erneut. Die Action ersetzt den Platzhalter `__BUILD__` in `sw.js` durch den Commit-Hash — kein manuelles Hochzählen der Cache-Version mehr, den Platzhalter nie entfernen.
- Nur die PWA wird aus diesem Repo deployt. Der Hosted-Worker/das Backend lebt im privaten Repo `qudiqudi/jobreif-backend` und deployt von dort über eigene GitHub Actions — Backend-/Prompt-Änderungen also dort, nicht hier.
- Vor dem Push lokal testen: UI-Flows per Browser durchklicken; Zustand lässt sich über die globalen Variablen quiz/answers/mode/revealed in der Konsole injizieren. Den Testserver IMMER selbstbegrenzend und nur auf Loopback starten:

      timeout 900 python3 -m http.server 8765 --bind 127.0.0.1

  `--bind 127.0.0.1` ist Pflicht — ohne das lauscht `http.server` laut `--help` auf allen Interfaces (`default: all interfaces`) und serviert dieses Repo samt `.git/` und Verzeichnis-Listings ins Netz. `timeout` ist Pflicht, weil es den Server überlebt und ihn nach Ablauf per SIGTERM beendet: Wer ihn per `… &` aus einer Shell startet, die sofort zurückkehrt, koppelt ihn ab — ein `trap … EXIT` auf dieser Shell feuert dann sofort (killt zu früh) oder nie. (Ein `trap` funktioniert nur, wenn die startende Shell mit `wait` am Leben bleibt; für Fire-and-forget taugt er nicht.) Am Ende zusätzlich explizit abräumen und nachprüfen, statt es zu glauben — PID merken statt nach Mustern zu suchen:

      timeout 900 python3 -m http.server 8765 --bind 127.0.0.1 & SRV=$!
      # ... testen ...
      kill $SRV; ss -ltn 'sport = :8765' | tail -n +2 | grep -q . && echo "NOCH BELEGT" || echo "Port frei"

  Zwei Fallen, beide praktisch verifiziert: `pkill -f "http.server 8765"` trifft **jeden** Prozess, dessen Kommandozeile den String enthält — auch die eigene umschließende Shell und den 8765-Server eines parallel arbeitenden Agents. Und `ss -ltn | grep 8765` liefert einen Treffer für einen Listener auf `18765`; deshalb der exakte `sport`-Filter.

  Hintergrund: Am 09.07.2026 liefen zehn so entstandene Waisen-Server, der älteste seit dem 27.06.; vier davon servierten dieses Repo auf `0.0.0.0`. Beim Suchen nach Waisen kein Präfix-Muster wie `pgrep -f "http.server 87"` benutzen — das fand nur die Ports, die mit 87 beginnen, und übersah sieben von zehn.
- Deploy verifizieren: `gh run watch` bzw. mit Cache-Buster `curl -s "https://jobreif.de/sw.js?t=$RANDOM" | grep bewerbungstool-` (muss den Commit-Hash zeigen, nicht `__BUILD__`). Die alte github.io-Adresse leitet nur noch per 301 auf die Custom Domain um.

## API-Aufrufe

- Schema-Erweiterungen für die Fragengenerierung passieren serverseitig (privates Backend-Repo), aber: gespeicherte Versuche enthalten Quiz-Objekte im alten Schema — der Anzeige-Code hier muss damit umgehen (defensiv lesen).
- BYOK-Provider-Defaults im UI (Anbieterauswahl/Modelle) nicht ohne Begründung ändern. Modellkatalog und -Tuning des Hosted-Modus liegen im privaten Backend-Repo.
