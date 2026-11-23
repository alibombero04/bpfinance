// Netlify Function — proxy seguro a Anthropic API.
// La CLAUDE_API_KEY vive en Netlify env vars, no en el cliente.
//
// Env var requerida en Netlify dashboard:
//   CLAUDE_API_KEY — sk-ant-api03-...
//
// Quién puede usarla: solo Alex o Gaby con sesión abierta.
// La app manda dos tokens y la función se los presenta a Firebase intentando
// leer /pagos (shallow, solo las claves):
//   Authorization: Bearer <ID token de Firebase Auth>  → quién es
//   X-Firebase-AppCheck: <token de App Check>          → que viene de la app de verdad
// Firebase valida el token (firma, caducidad) y aplica las reglas de la base:
// /pagos solo lo leen Alex y Gaby. Si Firebase responde 200, la sesión es de
// ellos; cualquier otra respuesta es un rechazo.
// El Origin y el rate limit se quedan como capa extra, pero ya no son la defensa:
// el Origin lo puede falsificar cualquier script.

const ALLOWED_ORIGINS = [
  'https://bpfinanzas.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000'
];
const MAX_BODY_BYTES = 5_000_000;      // 5 MB — imagen o PDF (≤3.5 MB) en base64 + prompt; Netlify acepta hasta 6 MB
const RATE_LIMIT_PER_MIN = 30;         // reqs/min por IP

// Lo único que piden las apps. Cualquier otra cosa se rechaza para que nadie
// pueda gastar la API key con otro modelo o respuestas más largas.
const ALLOWED_MODELS = ['claude-sonnet-4-6'];
const MAX_TOKENS_CAP = 4096;

const FIREBASE_DB_URL = 'https://finanzas-bp-default-rtdb.firebaseio.com';

// Rate-limit en memoria (solo persiste mientras la función está "warm")
const rateMap = new Map();

function rateLimitCheck(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const entry = rateMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > windowMs) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  rateMap.set(ip, entry);
  return entry.count <= RATE_LIMIT_PER_MIN;
}

function header(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || '';
}

// Devuelve { ok: true } o { ok: false, status, message }.
// Un error nunca es un permiso: cualquier camino raro termina en rechazo.
async function verificarMiembro(event, fetchImpl = fetch) {
  const m = /^Bearer\s+(\S+)$/i.exec(header(event, 'authorization'));
  if (!m) return { ok: false, status: 401, message: 'Inicia sesión para usar la IA' };
  const idToken = m[1];
  const appCheck = header(event, 'x-firebase-appcheck');

  // shallow=true: solo las claves de primer nivel, no se descargan los pagos.
  const url = `${FIREBASE_DB_URL}/pagos.json?shallow=true&auth=${encodeURIComponent(idToken)}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: appCheck ? { 'X-Firebase-AppCheck': appCheck } : {} });
  } catch (e) {
    console.error('claude-proxy: no se pudo consultar Firebase', e);
    return { ok: false, status: 503, message: 'No se pudo comprobar la sesión, intenta de nuevo' };
  }
  if (res.status === 401 || res.status === 403) {
    // Token falso o caducado, cuenta sin acceso a /pagos, o sin App Check válido.
    let detalle = '';
    try { detalle = (await res.json()).error || ''; } catch (e) {}
    console.warn('claude-proxy: Firebase rechazó la sesión:', res.status, detalle);
    return { ok: false, status: 401, message: 'Sesión no válida, vuelve a entrar' };
  }
  if (!res.ok) {
    console.error('claude-proxy: Firebase respondió', res.status);
    return { ok: false, status: 503, message: 'No se pudo comprobar la sesión, intenta de nuevo' };
  }
  // Solo una respuesta 200 llega aquí: Firebase aceptó el token y las reglas
  // dejaron leer /pagos, que es solo de Alex y Gaby.
  return { ok: true };
}

const handler = async (event) => {
  const origin = header(event, 'origin');
  const isAllowedOrigin = ALLOWED_ORIGINS.includes(origin);

  const corsHeaders = {
    "Access-Control-Allow-Origin": isAllowedOrigin ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Firebase-AppCheck",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
  const responder = (statusCode, message) =>
    ({ statusCode, headers: corsHeaders, body: JSON.stringify({ error: { message } }) });

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") return responder(405, "Method Not Allowed");

  // Origin allowlist (capa extra; la defensa real es la sesión)
  if (!isAllowedOrigin) return responder(403, "Origin not allowed");

  // Body size guard
  if (event.body && event.body.length > MAX_BODY_BYTES) return responder(413, "Payload too large");

  // Rate limit por IP
  const ip = header(event, "x-forwarded-for").split(",")[0].trim() || header(event, "client-ip") || "unknown";
  if (!rateLimitCheck(ip)) return responder(429, "Rate limit exceeded (30 req/min)");

  // API key from env
  const API_KEY = process.env.CLAUDE_API_KEY;
  if (!API_KEY) {
    console.error("CLAUDE_API_KEY not configured in Netlify env");
    return responder(500, "API key not configured");
  }

  // Sesión: solo miembros registrados
  const sesion = await verificarMiembro(event);
  if (!sesion.ok) return responder(sesion.status, sesion.message);

  let body;
  try { body = JSON.parse(event.body || ''); } catch (e) { return responder(400, "JSON no válido"); }

  // Solo se reenvía lo que usan las apps: modelo permitido, tope de tokens y mensajes.
  if (!ALLOWED_MODELS.includes(body.model)) return responder(400, "Modelo no permitido");
  if (!Array.isArray(body.messages) || body.messages.length === 0) return responder(400, "Missing 'messages'");
  const maxTokens = Number.isInteger(body.max_tokens) && body.max_tokens > 0
    ? Math.min(body.max_tokens, MAX_TOKENS_CAP) : 1024;
  const limpio = { model: body.model, max_tokens: maxTokens, messages: body.messages };

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(limpio),
    });

    const data = await response.json();
    return {
      statusCode: response.status,
      headers: corsHeaders,
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error("claude-proxy error:", err);
    return responder(500, "Error al contactar la IA");
  }
};

exports.handler = handler;
exports._test = { verificarMiembro };
