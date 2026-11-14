# BPFinance (Finanzas_BP)

Pagos de tarjetas, propiedades (Casa, Arthouse, Townsquare), servicios y colegiaturas.
Solo para Alex y Gaby.

Es un proyecto **separado de NoteScanner** a propósito: otro proyecto de Firebase
(`finanzas-bp`), otro sitio de Netlify y otro repo. En este proyecto solo existen
dos cuentas y el registro de cuentas nuevas está apagado.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | La app completa |
| `netlify/functions/claude-proxy.js` | Lectura de comprobantes con IA. Solo atiende a sesiones que pueden leer `/pagos` |
| `database.rules.json` | Reglas de Realtime Database. Se pegan en la consola: Realtime Database → Reglas |
| `storage.rules` | Reglas de Storage. Se pegan en la consola: Storage → Reglas |

## La lista de acceso vive en tres lugares

Para dar o quitar acceso hay que cambiar los tres:

1. `ACCESO` en `index.html`
2. `database.rules.json`
3. `storage.rules`

Y crear o borrar la cuenta en Firebase → Authentication.

## Variables en Netlify

- `CLAUDE_API_KEY`: API key de Anthropic.

## Pendiente

- App Check: registrar la clave reCAPTCHA v3 del dominio y ponerla en `RECAPTCHA_SITE_KEY`.
