import { describe, expect, it } from "vitest";
import { parseWebhook, verifySignature } from "../src/whatsapp";

async function sign(body: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("parseWebhook", () => {
  it("lee texto, audio y nombre del contacto", () => {
    const body = {
      entry: [{ changes: [{ field: "messages", value: {
        contacts: [{ wa_id: "593911111111", profile: { name: "María" } }],
        messages: [
          { id: "m1", from: "593911111111", type: "text", text: { body: "Hola, precio del colágeno?" } },
          { id: "m2", from: "593911111111", type: "audio", audio: { id: "a" } },
        ],
      } }] }],
    };
    const { messages, echoes } = parseWebhook(body);
    expect(echoes).toEqual([]);
    expect(messages[0]).toEqual({ id: "m1", from: "593911111111", name: "María", text: "Hola, precio del colágeno?" });
    expect(messages[1].text).toContain("un audio");
  });

  it("lee los ecos de la app WhatsApp Business", () => {
    const body = { entry: [{ changes: [{ field: "smb_message_echoes", value: {
      message_echoes: [{ id: "e1", from: "593222", to: "593911111111", type: "text", text: { body: "Hola, soy Luis" } }],
    } }] }] };
    expect(parseWebhook(body).echoes).toEqual([{ id: "e1", to: "593911111111" }]);
  });

  it("ignora cuerpos vacíos o de estado", () => {
    expect(parseWebhook({})).toEqual({ messages: [], echoes: [] });
    expect(parseWebhook({ entry: [{ changes: [{ field: "messages", value: { statuses: [{}] } }] }] }).messages).toEqual([]);
  });
});

describe("verifySignature", () => {
  it("acepta la firma correcta y rechaza las demás", async () => {
    const body = '{"a":1}';
    expect(await verifySignature(body, await sign(body, "secreto"), "secreto")).toBe(true);
    expect(await verifySignature(body, await sign(body, "otro"), "secreto")).toBe(false);
    expect(await verifySignature(body, null, "secreto")).toBe(false);
  });
});
