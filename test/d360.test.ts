import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { configureWebhook, health } from "../src/index";
import { sendText } from "../src/whatsapp";
import { makeEnv } from "./helpers";

function env360() {
  const env = makeEnv();
  delete env.WHATSAPP_TOKEN;
  delete env.WHATSAPP_PHONE_NUMBER_ID;
  delete env.WHATSAPP_APP_SECRET;
  env.D360_API_KEY = "d360key";
  return env;
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

afterEach(() => vi.unstubAllGlobals());

describe("360dialog", () => {
  it("envía mensajes a waba-v2.360dialog.io con la cabecera D360-API-KEY", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return Response.json({ messages: [{ id: "wamid.1" }] });
    }));
    expect(await sendText(env360(), "593911111111", "Hola")).toBe("wamid.1");
    expect(calls[0].url).toBe("https://waba-v2.360dialog.io/messages");
    expect(calls[0].init.headers["D360-API-KEY"]).toBe("d360key");
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ messaging_product: "whatsapp", to: "593911111111", type: "text" });
  });

  it("acepta el webhook solo con la cabecera Authorization correcta", async () => {
    const env = env360();
    const post = (auth?: string) =>
      worker.fetch(
        new Request("https://x.workers.dev/webhook", {
          method: "POST",
          headers: auth ? { authorization: auth } : {},
          body: "{}",
        }),
        env,
        ctx,
      );
    expect((await post("Bearer verificar")).status).toBe(200);
    expect((await post("Bearer otra")).status).toBe(401);
    expect((await post()).status).toBe(401);
  });

  it("registra el webhook con la clave correcta", async () => {
    const env = env360();
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return new Response('{"url":"ok"}', { status: 200 });
    }));
    const denied = await configureWebhook(env, new URL("https://x.workers.dev/configurar-webhook?clave=mala"));
    expect(denied.status).toBe(403);
    const res = await configureWebhook(env, new URL("https://x.workers.dev/configurar-webhook?clave=verificar"));
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://waba-v2.360dialog.io/v1/configs/webhook");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      url: "https://x.workers.dev/webhook",
      headers: { Authorization: "Bearer verificar" },
    });
  });

  it("/salud solo pide D360_API_KEY para WhatsApp", async () => {
    const env = env360();
    env.D360_API_KEY = "";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { products: { nodes: [] } } })));
    const body: any = await (await health(env)).json();
    expect(body.faltan).toEqual(["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET"]);
    env.D360_API_KEY = "d360key";
    expect(((await (await health(env)).json()) as any).faltan).toEqual([]);
  });
});
