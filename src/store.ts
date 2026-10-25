import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";

type Message = Anthropic.Beta.Messages.BetaMessageParam;

export interface Conversation {
  messages: Message[];
  updatedAt: number;
  pausedUntil?: number; // el bot no responde hasta esta fecha (ms)
}

const DAY = 24 * 60 * 60 * 1000;
// Una pausa por escalado dura hasta que Luis reactive el chat (o 7 días).
export const ESCALATION_PAUSE = 7 * DAY;

export async function loadConversation(env: Env, phone: string): Promise<Conversation> {
  const conv = await env.STATE.get<Conversation>(`conv:${phone}`, "json");
  // Tras 24 h sin mensajes empieza una conversación nueva. El historial nunca se
  // recorta a medias: se envía siempre completo para respetar los bloques de
  // razonamiento que devuelve Claude.
  if (!conv || Date.now() - conv.updatedAt > DAY) {
    return { messages: [], updatedAt: Date.now(), pausedUntil: conv?.pausedUntil };
  }
  return conv;
}

export async function saveConversation(env: Env, phone: string, conv: Conversation) {
  conv.updatedAt = Date.now();
  await env.STATE.put(`conv:${phone}`, JSON.stringify(conv), { expirationTtl: 30 * 24 * 60 * 60 });
}

export function isPaused(conv: Conversation) {
  return (conv.pausedUntil ?? 0) > Date.now();
}

export async function setPause(env: Env, phone: string, untilMs: number | undefined) {
  const conv = await loadConversation(env, phone);
  conv.pausedUntil = untilMs;
  await saveConversation(env, phone, conv);
}

// Evita procesar dos veces el mismo mensaje (Meta reintenta los webhooks) y
// reconoce los ecos de mensajes que envió el propio bot.
export async function seen(env: Env, key: string) {
  if (await env.STATE.get(`seen:${key}`)) return true;
  await env.STATE.put(`seen:${key}`, "1", { expirationTtl: 2 * 24 * 60 * 60 });
  return false;
}

export function rememberSent(env: Env, messageId: string | undefined) {
  if (!messageId) return;
  return env.STATE.put(`sent:${messageId}`, "1", { expirationTtl: 2 * 24 * 60 * 60 });
}

export async function wasSentByBot(env: Env, messageId: string) {
  return (await env.STATE.get(`sent:${messageId}`)) !== null;
}
