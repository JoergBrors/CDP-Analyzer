# Sicherheit

## API-Key-Verschlüsselung

### safeStorage (Electron)

API-Keys werden via `electron.safeStorage` verschlüsselt gespeichert.

| Betriebssystem | Mechanismus | Schutz |
| --- | --- | --- |
| macOS | macOS Keychain | Nur eingeloggter User + diese App-Identität |
| Windows | DPAPI (Data Protection API) | Nur eingeloggter Windows-User |
| Linux | libsecret / kwallet | Desktop-Session-Key |

### Implementierung (`src/main.js`)

```js
function encryptKey(str) {
  if (!safeStorage.isEncryptionAvailable()) return { v: str };  // Fallback: Plaintext
  return { v: safeStorage.encryptString(str).toString('base64'), enc: true };
}

function decryptKey(entry) {
  if (!entry) return null;
  if (!entry.enc) return entry.v;  // Plaintext-Fallback oder Legacy
  try { return safeStorage.decryptString(Buffer.from(entry.v, 'base64')); }
  catch { return null; }
}
```

### Datei-Format

```json
{
  "enc": true,
  "keys": {
    "gemini": "BASE64_CIPHERTEXT",
    "openai": "BASE64_CIPHERTEXT"
  }
}
```

Der Ciphertext ist ohne den OS-Keychain-Key nicht entschlüsselbar. Ein einfaches `cat ai-key.json` zeigt nur Base64-Daten.

### Datei-Ort

```
macOS:   ~/Library/Application Support/cdp-analyzer/ai-key.json
Windows: %APPDATA%\cdp-analyzer\ai-key.json
Linux:   ~/.config/cdp-analyzer/ai-key.json
```

### Fallback

Wenn `safeStorage.isEncryptionAvailable()` `false` zurückgibt (z.B. headless CI/CD), wird Plaintext gespeichert — mit `enc: false` markiert. Das passiert in normalen Desktop-Umgebungen nicht.

### Migration von alten Versionen

Ältere Versionen speicherten Plaintext im Legacy-Feld `data.key`. Beim ersten `ai:loadKey`-Aufruf wird dieses Feld noch unterstützt, aber beim nächsten Speichern wird es gelöscht und durch verschlüsselte Keys ersetzt.

---

## Electron-Sicherheitsmodell

### Context Isolation

```js
webPreferences: {
  contextIsolation: true,    // Renderer kann Node.js nicht direkt nutzen
  nodeIntegration: false,    // window.require() ist nicht verfügbar
}
```

### Preload-Bridge (Whitelist-Prinzip)

Nur explizit in `preload.js` / `preload-ai.js` exponierte Funktionen sind aus dem Renderer erreichbar:

```js
contextBridge.exposeInMainWorld('cdp', {
  getTargets:    () => ipcRenderer.invoke('cdp:getTargets'),
  connect:       (url) => ipcRenderer.invoke('cdp:connect', url),
  // ... nur explizit genannte Funktionen
});
```

Der Renderer hat keinerlei Zugriff auf:
- Das Dateisystem
- Node.js-Module
- Electron-interne APIs
- Andere IPC-Kanäle als die exponierten

### CDP-Verbindung

- Nur zu `localhost:9222` — kein Remote-Zugriff möglich
- Chrome muss explizit mit `--remote-debugging-port=9222` gestartet werden
- Die App verbindet sich NUR auf expliziten Nutzer-Request (Tab-Auswahl + Verbinden-Button)

---

## Was an externe APIs gesendet wird

### AI-Anfragen (Gemini / OpenAI)

Gesendet werden:
- Der Nutzer-Prompt
- Aktive Context-Daten (je nach ausgewählten Pills):
  - API-Requests: URL, Methode, Status, Headers (ohne rohe Token-Strings), JWT-Payload (decodiert, ohne Signatur)
  - Network: URL, Methode, Status, Typ
  - Console: Log-Texte
  - Errors: URL, Status, Fehlertext

**Nicht gesendet:**
- Rohe Bearer-Tokens / API-Keys aus Headers
- Response-Bodies (außer wenn Agent explizit `getResponseBody` aufruft)
- Cookies
- Passwörter

### Tool-Call `getResponseBody`

Wenn der Agent dieses Tool aufruft, wird der Response-Body in der Antwort an die KI-API gesendet. Das ist bewusst — der Nutzer hat dieses Tool aktiviert damit der Agent API-Daten analysieren kann.

---

## Empfehlungen für den Betrieb

1. **Nur eigene Browser-Sessions debuggen** — CDP hat vollen Zugriff auf den Tab inkl. aller Daten
2. **Deep Intercept nur wenn nötig** — pausiert alle Requests, leichte Verlangsamung
3. **API-Keys nach Verdacht rotieren** — OpenAI unter [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
4. **Chrome-Profil isolieren** — `--user-data-dir` auf ein dediziertes Verzeichnis setzen, nicht das Standard-Profil verwenden
