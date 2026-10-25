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

export async function verifySignature(rawBody: string, header: string | null, appSecret: string) {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

async function send(env: Env, payload: Record<string, unknown>): Promise<string | undefined> {
  const version = env.GRAPH_API_VERSION ?? "v23.0";
  const res = await fetch(
    `https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    },
  );
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
