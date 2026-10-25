import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEnv } from "./helpers";

vi.mock("../src/agent", () => ({ runAgent: vi.fn() }));
const { runAgent } = await import("../src/agent");
const { handleEvents } = await import("../src/index");

let sent: any[];
beforeEach(() => {
  sent = [];
  let n = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ messages: [{ id: `wamid.bot${++n}` }] });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(runAgent).mockReset();
});

const customerMsg = (id: string, body: string, from = "593911111111") => ({
  entry: [{ changes: [{ field: "messages", value: {
    contacts: [{ wa_id: from, profile: { name: "María" } }],
    messages: [{ id, from, type: "text", text: { body } }],
  } }] }],
});
const texts = () => sent.filter((p) => p.type === "text");

describe("handleEvents", () => {
  it("responde al cliente y no procesa dos veces el mismo mensaje", async () => {
    const env = makeEnv();
    vi.mocked(runAgent).mockResolvedValue({ reply: "¡Hola María!", effects: {} });
    await handleEvents(env, customerMsg("m1", "hola"));
    await handleEvents(env, customerMsg("m1", "hola"));
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(texts()).toEqual([expect.objectContaining({ to: "593911111111", text: expect.objectContaining({ body: "¡Hola María!" }) })]);
  });

  it("al escalar avisa a Luis y deja de responder en ese chat", async () => {
    const env = makeEnv();
    vi.mocked(runAgent).mockResolvedValue({ reply: "Te paso con Luis", effects: { escalation: { motivo: "reclamo", resumen: "No llegó su pedido" } } });
    await handleEvents(env, customerMsg("m1", "no me llega"));
    const toLuis = texts().find((p) => p.to === env.LUIS_PHONE);
    expect(toLuis.text.body).toContain("reclamo");
    expect(toLuis.text.body).toContain("activar 593911111111");

    await handleEvents(env, customerMsg("m2", "hola??"));
    expect(runAgent).toHaveBeenCalledTimes(1);

    // Luis reactiva el bot
    await handleEvents(env, customerMsg("m3", "activar 593911111111", env.LUIS_PHONE));
    vi.mocked(runAgent).mockResolvedValue({ reply: "¿En qué te ayudo?", effects: {} });
    await handleEvents(env, customerMsg("m4", "hola de nuevo"));
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("avisa a Luis de cada pedido nuevo", async () => {
    const env = makeEnv();
    vi.mocked(runAgent).mockResolvedValue({ reply: "Pedido #1050 listo", effects: { order: { name: "#1050", total: "24.99", summary: "1 x Mini Cepillo", ciudad: "Quito" } } });
    await handleEvents(env, customerMsg("m1", "SÍ"));
    expect(texts().find((p) => p.to === env.LUIS_PHONE).text.body).toContain("Pedido nuevo #1050");
  });

  it("se calla cuando Luis escribe desde la app, pero no por sus propios mensajes", async () => {
    const env = makeEnv();
    vi.mocked(runAgent).mockResolvedValue({ reply: "Hola", effects: {} });
    await handleEvents(env, customerMsg("m1", "hola"));
    // eco del propio mensaje del bot: no pausa
    await handleEvents(env, { entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: [{ id: "wamid.bot2", to: "593911111111" }] } }] }] });
    await handleEvents(env, customerMsg("m2", "y el precio?"));
    expect(runAgent).toHaveBeenCalledTimes(2);
    // Luis escribe desde la app: pausa
    await handleEvents(env, { entry: [{ changes: [{ field: "smb_message_echoes", value: { message_echoes: [{ id: "wamid.luis", to: "593911111111" }] } }] }] });
    await handleEvents(env, customerMsg("m3", "gracias"));
    expect(runAgent).toHaveBeenCalledTimes(2);
  });
});
