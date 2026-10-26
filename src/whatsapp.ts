import type { Env } from "./env";

export interface IncomingMessage {
  id: string;
  from: string; // número del cliente, p. ej. 593991234567
  name?: string;
  text: string; // texto, o una descripción si no es texto
}

export interface EchoMessage {
  id: string;
  to: string; // cliente al que escribió Luis desde la app
}

export interface WebhookEvents {
  messages: IncomingMessage[];
  echoes: EchoMessage[];
}

const NON_TEXT_LABELS: Record<string, string> = {
  audio: "un audio",
  image: "una imagen",
  video: "un video",
  sticker: "un sticker",
  document: "un documento",
  location: "una ubicación",
  contacts: "un contacto",
};

// Extrae mensajes de clientes y "ecos" (mensajes que Luis envía desde la app
// WhatsApp Business en modo coexistencia) del cuerpo del webhook.
export function parseWebhook(body: any): WebhookEvents {
  const out: WebhookEvents = { messages: [], echoes: [] };
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      if (change.field === "messages") {
        const names = new Map<string, string>();
        for (const c of value.contacts ?? []) names.set(c.wa_id, c.profile?.name);
        for (const m of value.messages ?? []) {
          let text: string;
          if (m.type === "text") text = m.text?.body ?? "";
          else if (m.type === "button") text = m.button?.text ?? "";
          else if (m.type === "interactive")
            text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
          else {
            const label = NON_TEXT_LABELS[m.type] ?? "un mensaje que no es texto";
            const caption = m[m.type]?.caption;
            text = `[El cliente envió ${label} que no puedes ver${caption ? `, con el texto: "${caption}"` : ""}]`;
          }
          out.messages.push({ id: m.id, from: m.from, name: names.get(m.from), text });
        }
      } else if (change.field === "smb_message_echoes") {
        for (const e of value.message_echoes ?? []) out.echoes.push({ id: e.id, to: e.to });
      }
    }
  }
  return out;
}

// Meta firma con "sha256=<hex>"; Kapso (webhook tipo "meta") con el hex sin prefijo.
export async function verifySignature(rawBody: string, header: string | null, appSecret: string, prefix = "sha256=") {
  if (!appSecret || !header?.startsWith(prefix)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(prefix.length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export const D360_BASE = "https://waba-v2.360dialog.io";

export const KAPSO_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";

export const usesKapso = (env: Env) => Boolean(env.KAPSO_API_KEY);
export const uses360dialog = (env: Env) => !usesKapso(env) && Boolean(env.D360_API_KEY);

// Kapso y 360dialog exponen la misma API de Meta en otra dirección y con otra cabecera.
function endpoint(env: Env): { url: string; headers: Record<string, string> } {
  if (usesKapso(env)) {
    return {
      url: `${KAPSO_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      headers: { "X-API-Key": env.KAPSO_API_KEY! },
    };
  }
  if (uses360dialog(env)) {
    return { url: `${D360_BASE}/messages`, headers: { "D360-API-KEY": env.D360_API_KEY! } };
  }
  const version = env.GRAPH_API_VERSION ?? "v23.0";
  return {
    url: `https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
  };
}

// Con 360dialog el webhook no viene firmado: se registra con una cabecera
// Authorization secreta que se compara aquí.
export function verifyBearer(header: string | null, token: string) {
  const expected = `Bearer ${token}`;
  if (!token || !header || header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

export async function register360Webhook(env: Env, webhookUrl: string) {
  const res = await fetch(`${D360_BASE}/v1/configs/webhook`, {
    method: "POST",
    headers: { "D360-API-KEY": env.D360_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, headers: { Authorization: `Bearer ${env.WHATSAPP_VERIFY_TOKEN}` } }),
  });
  return { status: res.status, body: (await res.text()).slice(0, 500) };
}

async function send(env: Env, payload: Record<string, unknown>): Promise<string | undefined> {
  const { url, headers } = endpoint(env);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${JSON.stringify(data?.error ?? data)}`);
  return data?.messages?.[0]?.id;
}

export function sendText(env: Env, to: string, body: string) {
  return send(env, { to, type: "text", text: { body, preview_url: true } });
}

export function markRead(env: Env, messageId: string) {
  return send(env, { status: "read", message_id: messageId }).catch(() => undefined);
}

// Aviso a Luis. Con plantilla aprobada llega aunque Luis no haya escrito al
// número del negocio en las últimas 24 h; sin plantilla se intenta texto libre.
export async function notifyLuis(env: Env, text: string) {
  if (env.ALERT_TEMPLATE) {
    return send(env, {
      to: env.LUIS_PHONE,
      type: "template",
      template: {
        name: env.ALERT_TEMPLATE,
        language: { code: env.ALERT_TEMPLATE_LANG ?? "es" },
        components: [{ type: "body", parameters: [{ type: "text", text: text.slice(0, 1000) }] }],
      },
    });
  }
  return sendText(env, env.LUIS_PHONE, text);
}
