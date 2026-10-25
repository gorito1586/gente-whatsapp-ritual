import { runAgent } from "./agent";
import type { Env } from "./env";
import {
  ESCALATION_PAUSE,
  isPaused,
  loadConversation,
  rememberSent,
  saveConversation,
  seen,
  setPause,
  wasSentByBot,
} from "./store";
import { markRead, notifyLuis, parseWebhook, sendText, verifySignature, type IncomingMessage } from "./whatsapp";

const HANDOFF = "Te paso con Luis, que te atiende personalmente en breve 🙌";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/webhook") return new Response("Ritual Diario · agente de WhatsApp", { status: 200 });

    // Verificación del webhook al configurarlo en Meta.
    if (request.method === "GET") {
      const ok =
        url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === env.WHATSAPP_VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
    }

    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const raw = await request.text();
    if (!(await verifySignature(raw, request.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }

    // Meta espera un 200 rápido; el trabajo sigue en segundo plano.
    ctx.waitUntil(handleEvents(env, JSON.parse(raw)));
    return new Response("OK");
  },
};

export async function handleEvents(env: Env, body: unknown) {
  const { messages, echoes } = parseWebhook(body);

  // Luis escribió a un cliente desde la app: el bot se calla en ese chat.
  for (const echo of echoes) {
    if (await wasSentByBot(env, echo.id)) continue;
    const hours = Number(env.PAUSE_HOURS ?? "12");
    await setPause(env, echo.to, Date.now() + hours * 60 * 60 * 1000);
  }

  for (const msg of messages) {
    if (await seen(env, msg.id)) continue;
    try {
      if (msg.from === env.LUIS_PHONE) await handleLuisCommand(env, msg);
      else await handleCustomer(env, msg);
    } catch (err) {
      console.error("Error procesando mensaje", msg.id, err);
    }
  }
}

// Comandos que Luis envía desde su WhatsApp personal al número del negocio:
//   activar 593991234567  -> el bot vuelve a atender ese chat
//   pausar 593991234567   -> el bot deja de atender ese chat
export async function handleLuisCommand(env: Env, msg: IncomingMessage) {
  const match = msg.text.trim().match(/^(activar|pausar)\s+\+?(\d{8,15})$/i);
  if (!match) {
    await sendText(env, env.LUIS_PHONE, "Comandos: *activar 5939XXXXXXXX* o *pausar 5939XXXXXXXX*");
    return;
  }
  const [, command, phone] = match;
  const resume = command.toLowerCase() === "activar";
  await setPause(env, phone, resume ? undefined : Date.now() + ESCALATION_PAUSE);
  await sendText(env, env.LUIS_PHONE, resume ? `✅ Bot activo otra vez con +${phone}` : `⏸️ Bot pausado con +${phone}`);
}

export async function handleCustomer(env: Env, msg: IncomingMessage) {
  const conv = await loadConversation(env, msg.from);
  if (isPaused(conv)) return; // Luis está atendiendo este chat
  await markRead(env, msg.id);

  const { reply, effects } = await runAgent(env, conv, msg.from, msg.name, msg.text);
  if (effects.escalation) conv.pausedUntil = Date.now() + ESCALATION_PAUSE;
  await saveConversation(env, msg.from, conv);

  await rememberSent(env, await sendText(env, msg.from, reply || HANDOFF));

  const who = `${msg.name ?? "Cliente"} (+${msg.from})`;
  if (effects.escalation) {
    await notifyLuis(
      env,
      `🔔 Caso para Luis · ${who} · Motivo: ${effects.escalation.motivo} · ${effects.escalation.resumen} · ` +
        `Chat: https://wa.me/${msg.from} · Cuando termines, envía: activar ${msg.from}`,
    );
  }
  if (effects.order) {
    const o = effects.order;
    await notifyLuis(env, `🛍️ Pedido nuevo ${o.name} · ${o.summary} · $${o.total} · ${o.ciudad} · ${who}`);
  }
}
