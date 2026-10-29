import { runAgent } from "./agent";
import type { Env } from "./env";
import { getCatalog } from "./shopify";
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
import {
  markRead,
  notifyLuis,
  parseWebhook,
  register360Webhook,
  sendText,
  uses360dialog,
  usesKapso,
  verifyBearer,
  verifySignature,
  type IncomingMessage,
} from "./whatsapp";

const HANDOFF = "Te paso con Luis, que te atiende personalmente en breve 🙌";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/salud") return health(env);
    if (url.pathname === "/configurar-webhook") return configureWebhook(env, url);
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
    const authorized = usesKapso(env)
      ? await verifySignature(raw, request.headers.get("x-webhook-signature"), env.KAPSO_WEBHOOK_SECRET ?? "", "")
      : uses360dialog(env)
        ? verifyBearer(request.headers.get("authorization"), env.WHATSAPP_VERIFY_TOKEN ?? "")
        : await verifySignature(raw, request.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET ?? "");
    if (!authorized) {
      await logEvent(env, "ultimo_webhook", "rechazado: firma inválida (revisa KAPSO_WEBHOOK_SECRET)");
      return new Response("Invalid signature", { status: 401 });
    }

    // Meta espera un 200 rápido; el trabajo sigue en segundo plano.
    ctx.waitUntil(handleEvents(env, JSON.parse(raw)));
    return new Response("OK");
  },
};

// Revisión rápida de la configuración: qué secretos faltan y si Shopify responde.
export async function health(env: Env) {
  const whatsapp = usesKapso(env)
    ? (["KAPSO_API_KEY", "KAPSO_WEBHOOK_SECRET", "WHATSAPP_PHONE_NUMBER_ID"] as const)
    : uses360dialog(env)
      ? (["D360_API_KEY", "WHATSAPP_VERIFY_TOKEN"] as const)
      : (["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"] as const);
  const required = [...whatsapp, "SHOPIFY_STORE_DOMAIN", "ANTHROPIC_API_KEY", "LUIS_PHONE"] as const;
  const faltan: string[] = required.filter((k) => !env[k]);
  if (!env.SHOPIFY_ADMIN_TOKEN && !(env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET)) {
    faltan.push("SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET");
  }
  let shopify: string;
  try {
    shopify = `ok, ${(await getCatalog(env)).length} productos activos`;
  } catch (err) {
    shopify = `error: ${String(err).slice(0, 300)}`;
  }
  const permisos_shopify = (await env.STATE.get("shopify_scopes")) ?? "(sin token todavía)";
  const ultimo_webhook = (await env.STATE.get("diag:ultimo_webhook")) ?? "(ninguno todavía)";
  const ultimo_paso = (await env.STATE.get("diag:ultimo_paso")) ?? "(ninguno todavía)";
  const ultimo_error = (await env.STATE.get("diag:ultimo_error")) ?? "(ninguno)";
  return Response.json({ faltan, shopify, permisos_shopify, ultimo_webhook, ultimo_paso, ultimo_error });
}

// Registra en 360dialog la dirección del webhook. Se abre una vez desde el
// navegador: /configurar-webhook?clave=<WHATSAPP_VERIFY_TOKEN>
export async function configureWebhook(env: Env, url: URL) {
  if (!uses360dialog(env)) return new Response("Falta D360_API_KEY", { status: 400 });
  if (!env.WHATSAPP_VERIFY_TOKEN || url.searchParams.get("clave") !== env.WHATSAPP_VERIFY_TOKEN) {
    return new Response("Clave incorrecta", { status: 403 });
  }
  const result = await register360Webhook(env, `${url.origin}/webhook`);
  return Response.json({ webhook: `${url.origin}/webhook`, respuesta_360dialog: result });
}

// Deja rastro en KV para que /salud muestre qué pasó con el último webhook.
export async function logEvent(env: Env, key: string, detail: string) {
  await env.STATE.put(`diag:${key}`, `${new Date().toISOString()} · ${detail}`, { expirationTtl: 7 * 24 * 60 * 60 });
}

export async function handleEvents(env: Env, body: unknown) {
  const { messages, echoes } = parseWebhook(body);
  await logEvent(env, "ultimo_webhook", `ok: ${messages.length} mensajes, ${echoes.length} ecos`);

  // Luis escribió a un cliente desde la app: el bot se calla en ese chat.
  for (const echo of echoes) {
    if (await wasSentByBot(env, echo.id)) continue;
    const hours = Number(env.PAUSE_HOURS ?? "12");
    await setPause(env, echo.to, Date.now() + hours * 60 * 60 * 1000);
  }

  for (const msg of messages) {
    if (await seen(env, msg.id)) continue;
    try {
      if (msg.from === env.LUIS_PHONE) {
        await logEvent(env, "ultimo_paso", "mensaje de Luis (comando)");
        await handleLuisCommand(env, msg);
      }
      else await handleCustomer(env, msg);
    } catch (err) {
      console.error("Error procesando mensaje", msg.id, err);
      await logEvent(env, "ultimo_error", String(err).slice(0, 500));
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
  if (isPaused(conv)) {
    await logEvent(env, "ultimo_paso", `chat de +${msg.from} en pausa, no responde`);
    return; // Luis está atendiendo este chat
  }
  await logEvent(env, "ultimo_paso", `+${msg.from}: consultando a Claude`);
  await markRead(env, msg.id);

  const { reply, effects } = await runAgent(env, conv, msg.from, msg.name, msg.text);
  await logEvent(env, "ultimo_paso", `+${msg.from}: Claude respondió, enviando`);
  if (effects.escalation) conv.pausedUntil = Date.now() + ESCALATION_PAUSE;
  await saveConversation(env, msg.from, conv);

  await rememberSent(env, await sendText(env, msg.from, reply || HANDOFF));
  await logEvent(env, "ultimo_paso", `+${msg.from}: respuesta enviada`);

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
