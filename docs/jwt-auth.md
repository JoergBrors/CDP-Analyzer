# JWT & Auth — Implementierung

## Überblick

JWT-Tokens werden vollständig **client-seitig** decodiert — kein Server-Call, keine externen Abhängigkeiten.
Die Signatur wird nicht verifiziert (kein Private Key vorhanden), nur Payload und Header werden gelesen.

---

## JWT Dekodierung (`renderer.js`)

### Basis-Decodierung

```js
function decodeJwtForDisplay(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return '<kein gültiger JWT>';

  const b64 = s => {
    // Base64url → Base64: - → + und _ → /
    const fixed = s.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(fixed);
    return JSON.parse(json);
  };

  const header  = b64(parts[0]);
  const payload = b64(parts[1]);
  // parts[2] = Signatur (nicht decodiert, nicht verifiziert)
}
```

### Wichtige Microsoft Entra ID Claims

| Claim | Bedeutung |
| --- | --- |
| `name` | Anzeigename des Nutzers |
| `upn` | User Principal Name (meist E-Mail) |
| `preferred_username` | Login-Name |
| `oid` | Object ID des Nutzers in Entra ID |
| `tid` | Tenant ID (welches Azure AD) |
| `appid` / `azp` | Client Application ID |
| `aud` | Audience (für welche API ist der Token) |
| `iss` | Issuer (Entra ID Instanz) |
| `scp` | OAuth2 Scopes (Space-separated) |
| `roles` | App-Rollen (Array) |
| `exp` | Expiry (Unix Timestamp) |
| `iat` | Issued At (Unix Timestamp) |
| `ver` | Token Version (`1.0` oder `2.0`) |

### Ablauf-Erkennung

```js
const now = Date.now() / 1000;
const expired  = payload.exp && now > payload.exp;
const expiring = payload.exp && !expired && (payload.exp - now) < 300;  // < 5 Min
```

Farbgebung im UI:

- Grün: `exp > now + 5min`
- Gelb (warnendes Pulsieren): `exp` innerhalb 5 Minuten
- Rot (Pulsieren): `exp < now`

### Microsoft Entra ID Erkennung

```js
const isMSFT = /login\.microsoftonline\.com|sts\.windows\.net/i.test(payload.iss || '');
```

Wenn `true`: Microsoft-Badge + Tenant-ID + Object-ID werden hervorgehoben.

---

## Auth-Erkennung in Requests (`detectAuth`)

```js
function detectAuth(headers) {
  for (const [k, v] of Object.entries(headers)) {
    if (/^authorization$/i.test(k)) {
      const lower = v.toLowerCase();
      if (lower.startsWith('bearer ')) {
        return { type: 'Bearer JWT', rawToken: v.slice(7) };
      }
      if (lower.startsWith('basic ')) {
        return { type: 'Basic Auth', rawToken: null };
      }
    }
    if (/^x-api-key$/i.test(k)) return { type: 'API-Key', rawToken: null };
    if (/^cookie$/i.test(k)) return { type: 'Cookie', rawToken: null };
  }
  return null;
}
```

`rawToken` wird **nur für JWT** gespeichert — API-Keys, Cookies etc. werden nicht an die KI oder UI weitergegeben.

---

## JWT im AI-Kontext

Wenn der Agent die API-Kontextpill aktiviert, werden Bearer-Tokens decodiert bevor sie gesendet werden:

```js
// In buildContext() / ai-renderer.js:
const slim = {
  name, upn, preferred_username, tid, oid, appid, azp,
  scp, roles, aud, iss, exp, iat, ver
  // NUR diese Felder — kein roher Token, keine Signatur
};
const expired = slim.exp && Date.now()/1000 > slim.exp;
return `Authorization: Bearer <JWT${expired ? ' ABGELAUFEN' : ''}>\nJWT-Payload: ${JSON.stringify(slim)}`;
```

Der rohe Token-String (mit Signatur) wird **nicht** an die KI-API gesendet.

---

## UI-Darstellung (Auth-Tab)

```
┌─────────────────────────────────────────────────────┐
│  [grün] Gültig bis 14:32 Uhr     [Microsoft Entra]  │
├─────────────────────────────────────────────────────┤
│  Nutzer                                              │
│    Name    │ John Doe                                │
│    UPN     │ john@contoso.com                        │
│    OID     │ 12345678-...                            │
├─────────────────────────────────────────────────────┤
│  Token                                               │
│    Audience  │ https://graph.microsoft.com           │
│    Tenant    │ 87654321-...                          │
│    App-ID    │ 11223344-...                          │
│    Ablauf    │ 2025-01-15T14:32:00Z                  │
├─────────────────────────────────────────────────────┤
│  Berechtigungen                                      │
│  [User.Read] [Mail.Send] [Files.ReadWrite.All]       │
│                                                      │
│  Rollen                                              │
│  [GlobalAdmin]                                       │
└─────────────────────────────────────────────────────┘
```

Scope-Chips (blau) und Rollen-Chips (lila) sind visuell unterschieden.

---

## Sicherheitshinweise

- JWT-Dekodierung ist lokal, keine Netzwerkkommunikation
- Signaturen werden **nicht** verifiziert — Tokens könnten manipuliert sein (relevant nur wenn Tokens aus nicht-vertrauenswürdigen Quellen)
- Im normalen Debugging-Kontext ist das kein Problem, da wir Tokens vom Browser lesen (die bereits vom Chrome verwendet werden)
- API-Keys im Filesystem sind jetzt via `safeStorage` verschlüsselt (macOS Keychain)
- Rohe Token-Strings gelangen nicht in externe KI-API-Anfragen
