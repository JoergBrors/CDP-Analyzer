# Bekannte Issues & Limitierungen

## Aktuelle Limitierungen

### Response-Body-Cache

- Nur API-ähnliche Requests werden gecacht (JSON, XML, GraphQL + API-Pfad-Muster)
- Max 400 Einträge — bei vielen Requests werden älteste verdrängt
- Binäre Responses (Base64-encoded) werden nicht inhaltlich durchsucht
- Der Cache wird bei App-Neustart geleert (kein Persistenz)

### Deep Intercept

- Verlangsamt alle Requests marginal (jeder Request wird pausiert + sofort freigegeben)
- Muss nach Seiten-Reload manuell erneut aktiviert werden falls die Seite vorher nicht über Deep Intercept geladen wurde (Monkey-Patch wird für neue Dokumente aber automatisch via `addScriptToEvaluateOnNewDocument` injiziert)
- Bei SPA-Navigation (ohne Reload) bleibt der Monkey-Patch aktiv

### Batch-Responses

- Asynchrone Batch-Responses (HTTP 202 + Location) werden erkannt aber nicht automatisch nachgeladen
- Sehr große Sub-Response-Bodies können das UI verlangsamen

### AI Agent

- Max 12 Tool-Call-Iterationen pro Anfrage (Schutz vor Endlosschleifen)
- Kontext-History begrenzt auf 10 Turns (ältere werden abgeschnitten)
- Screenshots werden als base64-PNG gesendet — bei großen Fenstern hohe Token-Kosten
- OpenAI o1/o3-Modelle unterstützen kein Tool-Calling mit `stream: true` gleichzeitig

### JWT-Dekodierung

- Nur Payload wird decodiert (keine Signaturverifikation)
- Base64url-Padding-Fehler bei sehr kurzen Tokens möglich (selten)

### Windows-spezifisch

- `titleBarStyle: 'hiddenInset'` ist macOS-spezifisch — auf Windows Standard-Titelleiste
- `safeStorage` nutzt DPAPI — an Windows-User-Account gebunden (nicht portable)

---

## Fixe Bugs (Referenz)

| Bug | Symptom | Fix |
| --- | --- | --- |
| Streaming-Text in Spalten | Jedes Wort in neuer Zeile | `textContent` während Stream, `innerHTML = markdownToHtml()` danach |
| Bubble schrumpft | AI-Antwort wird schmal | `width: 100%` statt `align-self: flex-start` |
| macOS Traffic Lights | UI-Elemente hinter Buttons | `padding-left: 80px` auf `#topbar` |
| `/v1.0/` nicht erkannt als API | Config.office.com fehlt in API-Liste | `v\d+(?:\.\d+)*` statt `v\d+` |
| `config.office.com` nicht erkannt | Requests fehlen in API-Panel | `config.` zu `HOST_RE` hinzugefügt |
| Response-Body "nicht verfügbar" | Klick auf Zeile zeigt kein Body | Proaktiver Cache bei `loadingFinished` |
| `detectAuth()` crash | TypeError auf JWT-Anzeige | `rawToken` statt Array speichern |
| Agent: "kann Daten nicht sehen" | Agent antwortet ohne Inhalt | `getResponseBody` + `searchInData` Tools |
| API-Keys Plaintext | `ai-key.json` lesbar | `safeStorage` Verschlüsselung |

---

## Potenzielle Erweiterungen

### Datenexport

- Requests als HAR-File exportieren
- Batch-Analyse als Markdown/JSON exportieren
- Screenshot-Sequenz exportieren

### Persistenz

- Response-Body-Cache auf Disk speichern (SQLite oder JSON-File)
- Session-Replay: alle Requests einer Sitzung speichern und später laden

### Erweiterte Analyse

- Request-Timing-Aggregation: Welche Endpoints sind am langsamsten?
- Duplikat-Erkennung: Gleiche Requests mehrfach gesendet?
- CORS-Fehler-Analyse: Automatische Erklärung von Preflight-Fehlern

### AI-Verbesserungen

- Anthropic Claude als dritten Provider hinzufügen
- Kontext-Komprimierung für lange Sessions (statt einfachem Abschneiden)
- Gespeicherte Prompts / Prompt-Vorlagen
- Multi-Tab-Analyse: Mehrere Browser-Tabs gleichzeitig überwachen

### Sicherheit

- Keychain-Integration für macOS (statt safeStorage) für bessere App-Identifikation
- Optional: Lokales Modell (Ollama) für vollständig offline Betrieb
