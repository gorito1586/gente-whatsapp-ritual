import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";
import { SYSTEM_PROMPT } from "./prompt";
import { createOrder, getCatalog, searchCatalog, type OrderInput } from "./shopify";
import type { Conversation } from "./store";

type Tool = Anthropic.Beta.Messages.BetaTool;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

const MAX_UNITS = 5;
const MAX_STEPS = 6;

export const TOOLS: Tool[] = [
  {
    name: "buscar_productos",
    description:
      "Busca en el catálogo en vivo de Ritual Diario. Devuelve nombre, enlace, descripción y variantes con id, precio en USD y stock. Sin texto devuelve todo el catálogo.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { texto: { type: "string", description: "Palabras a buscar; vacío para todo el catálogo." } },
      required: ["texto"],
      additionalProperties: false,
    },
  },
  {
    name: "crear_pedido",
    description:
      "Crea un pedido contra entrega en Shopify. Úsala solo después de mostrar el resumen y recibir un SÍ del cliente en su último mensaje.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              variant_id: { type: "string", description: "id de la variante devuelto por buscar_productos" },
              quantity: { type: "integer" },
            },
            required: ["variant_id", "quantity"],
            additionalProperties: false,
          },
        },
        nombre: { type: "string" },
        apellido: { type: "string" },
        cedula: { type: "string" },
        telefono: { type: "string" },
        provincia: { type: "string" },
        ciudad: { type: "string" },
        direccion: { type: "string" },
        referencia: { type: "string" },
      },
      required: ["items", "nombre", "apellido", "cedula", "telefono", "provincia", "ciudad", "direccion", "referencia"],
      additionalProperties: false,
    },
  },
  {
    name: "escalar_a_luis",
    description:
      "Pasa la conversación a Luis y avisa a su WhatsApp personal. Después de usarla, el asistente deja de responder en este chat.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Motivo corto, p. ej. 'reclamo', 'salud', 'mayorista'." },
        resumen: { type: "string", description: "Qué pide el cliente, en una o dos frases." },
      },
      required: ["motivo", "resumen"],
      additionalProperties: false,
    },
  },
];

export interface Effects {
  escalation?: { motivo: string; resumen: string };
  order?: { name: string; total: string; summary: string; ciudad: string };
}

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function isConfirmation(text: string) {
  return /(^|[^a-z])(si|confirmo|confirmado)([^a-z]|$)/.test(normalize(text));
}

function lastUserText(conv: Conversation): string {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

async function runTool(
  env: Env,
  conv: Conversation,
  phone: string,
  name: string,
  input: any,
  effects: Effects,
): Promise<{ content: string; is_error?: boolean }> {
  switch (name) {
    case "buscar_productos": {
      const products = searchCatalog(await getCatalog(env), input.texto);
      return { content: JSON.stringify(products) };
    }
    case "crear_pedido": {
      const order = input as OrderInput;
      if (!isConfirmation(lastUserText(conv))) {
        return {
          content: "El último mensaje del cliente no confirma el pedido. Muéstrale el resumen y pídele que responda SÍ.",
          is_error: true,
        };
      }
      const units = order.items.reduce((n, i) => n + i.quantity, 0);
      if (units < 1 || units > MAX_UNITS) {
        return { content: `Pedido de ${units} unidades: no lo crees, escala a Luis.`, is_error: true };
      }
      const created = await createOrder(env, order, phone);
      effects.order = { ...created, ciudad: order.ciudad };
      return { content: JSON.stringify({ pedido: created.name, total_usd: created.total }) };
    }
    case "escalar_a_luis": {
      effects.escalation = { motivo: input.motivo, resumen: input.resumen };
      return { content: "Luis fue avisado. Despídete con el mensaje de traspaso y no hagas nada más." };
    }
    default:
      return { content: `Herramienta desconocida: ${name}`, is_error: true };
  }
}

// Ejecuta un turno: agrega el mensaje del cliente, deja que Claude use las
// herramientas y devuelve el texto final para enviar por WhatsApp.
export async function runAgent(
  env: Env,
  conv: Conversation,
  phone: string,
  customerName: string | undefined,
  text: string,
  client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
): Promise<{ reply: string; effects: Effects }> {
  const effects: Effects = {};
  const prefix = conv.messages.length === 0 && customerName ? `[Nombre en WhatsApp: ${customerName}]\n` : "";
  conv.messages.push({ role: "user", content: prefix + text });

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: env.CLAUDE_MODEL ?? "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: env.CLAUDE_EFFORT ?? "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: conv.messages,
    });

    // Se guarda el contenido completo (incluidos los bloques de razonamiento).
    conv.messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      effects.escalation ??= { motivo: "otro", resumen: "El asistente no pudo responder este mensaje." };
      return { reply: "Te paso con Luis, que te atiende personalmente en breve 🙌", effects };
    }

    if (response.stop_reason !== "tool_use") {
      const reply = response.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n")
        .trim();
      return { reply, effects };
    }

    const results: ToolResult[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      try {
        const r = await runTool(env, conv, phone, block.name, block.input, effects);
        results.push({ type: "tool_result", tool_use_id: block.id, ...r });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(err), is_error: true });
      }
    }
    conv.messages.push({ role: "user", content: results });
  }

  effects.escalation ??= { motivo: "otro", resumen: "El asistente no logró resolver la consulta." };
  const reply = "Te paso con Luis, que te atiende personalmente en breve 🙌";
  conv.messages.push({ role: "assistant", content: reply });
  return { reply, effects };
}
