import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { health } from "../src/index";
import { sendText } from "../src/whatsapp";
import { makeEnv } from "./helpers";

function envKapso() {
  const env = makeEnv();
  delete env.WHATSAPP_TOKEN;
  delete env.WHATSAPP_APP_SECRET;
  env.WHATSAPP_PHONE_NUMBER_ID = "123456789012345";
  env.KAPSO_API_KEY = "kapso-key";
  env.KAPSO_WEBHOOK_SECRET = "kapso-secret";
  return env;
}

async function hexHmac(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

afterEach(() => vi.unstubAllGlobals());

describe("Kapso", () => {
  it("envía por api.kapso.ai con la cabecera X-API-Key", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      return Response.json({ messages: [{ id: "wamid.k1" }] });
    }));
    expect(await sendText(envKapso(), "593911111111", "Hola")).toBe("wamid.k1");
    expect(calls[0].url).toBe("https://api.kapso.ai/meta/whatsapp/v24.0/123456789012345/messages");
    expect(calls[0].init.headers["X-API-Key"]).toBe("kapso-key");
  });

  it("verifica X-Webhook-Signature (hex sin prefijo) del webhook tipo meta", async () => {
    const env = envKapso();
    const body = '{"entry":[]}';
    const post = (sig?: string) =>
      worker.fetch(
        new Request("https://x.workers.dev/webhook", { method: "POST", headers: sig ? { "x-webhook-signature": sig } : {}, body }),
        env,
        ctx,
      );
    expect((await post(await hexHmac(body, "kapso-secret"))).status).toBe(200);
    expect((await post(await hexHmac(body, "otra"))).status).toBe(401);
    expect((await post("sha256=" + (await hexHmac(body, "kapso-secret")))).status).toBe(401);
    expect((await post()).status).toBe(401);
  });

  it("/salud pide las claves de Kapso", async () => {
    const env = envKapso();
    env.KAPSO_WEBHOOK_SECRET = "";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: { products: { nodes: [] } } })));
    const body: any = await (await health(env)).json();
    expect(body.faltan).toEqual(["KAPSO_WEBHOOK_SECRET"]);
  });
});
