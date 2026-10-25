import { afterEach, describe, expect, it, vi } from "vitest";
import { isConfirmation, runAgent } from "../src/agent";
import { searchCatalog, type Product } from "../src/shopify";
import { CATALOG_RESPONSE, fakeClaude, makeEnv, text, toolUse } from "./helpers";

const ORDER = {
  items: [{ variant_id: "gid://shopify/ProductVariant/21", quantity: 1 }],
  nombre: "María", apellido: "Pérez", cedula: "1712345678", telefono: "0991111111",
  provincia: "Pichincha", ciudad: "Quito", direccion: "Av. Amazonas N34", referencia: "Junto a la farmacia",
};

function mockShopify() {
  const calls: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.query.includes("orderCreate")) {
      return Response.json({ data: { orderCreate: { order: { id: "gid://shopify/Order/9", name: "#1050", totalPriceSet: { shopMoney: { amount: "24.99" } } }, userErrors: [] } } });
    }
    return Response.json(CATALOG_RESPONSE);
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("isConfirmation", () => {
  it("reconoce un sí con o sin tilde", () => {
    expect(isConfirmation("SÍ")).toBe(true);
    expect(isConfirmation("si, confirmo")).toBe(true);
    expect(isConfirmation("Sí por favor")).toBe(true);
    expect(isConfirmation("quiero saber el precio")).toBe(false);
    expect(isConfirmation("simplemente pregunto")).toBe(false);
  });
});

describe("searchCatalog", () => {
  const catalog = [
    { title: "NeoCell Colageno", type: "Salud", description: "" },
    { title: "Almohada Cervical", type: "Hogar", description: "" },
  ] as Product[];
  it("ignora tildes y mayúsculas", () => {
    expect(searchCatalog(catalog, "COLÁGENO").map((p) => p.title)).toEqual(["NeoCell Colageno"]);
  });
  it("devuelve todo si no hay coincidencias", () => {
    expect(searchCatalog(catalog, "zapatos")).toHaveLength(2);
  });
});

describe("runAgent", () => {
  it("busca productos y responde con el precio", async () => {
    const env = makeEnv();
    mockShopify();
    const claude = fakeClaude([toolUse("buscar_productos", { texto: "colágeno" }), text("El NeoCell cuesta $23.99 💪")]);
    const conv = { messages: [], updatedAt: Date.now() };
    const { reply, effects } = await runAgent(env, conv, "593911111111", "María", "precio colágeno?", claude);
    expect(reply).toBe("El NeoCell cuesta $23.99 💪");
    expect(effects).toEqual({});
    const toolResult = claude.requests[1].messages.at(-1).content[0];
    expect(toolResult.content).toContain("23.99");
    expect(toolResult.content).toContain("https://ritualdiarioec.store/products/neocell-colageno");
    expect(claude.requests[0].messages[0].content).toContain("[Nombre en WhatsApp: María]");
    expect(claude.requests[0].model).toBe("claude-opus-5-5");
  });

  it("no crea el pedido si el cliente no dijo SÍ", async () => {
    const env = makeEnv();
    const calls = mockShopify();
    const claude = fakeClaude([toolUse("crear_pedido", ORDER), text("¿Confirmas tu pedido? Responde SÍ")]);
    const conv = { messages: [], updatedAt: Date.now() };
    const { effects } = await runAgent(env, conv, "593911111111", undefined, "mis datos: María Pérez...", claude);
    expect(effects.order).toBeUndefined();
    expect(calls.some((c) => c.query.includes("orderCreate"))).toBe(false);
    expect(claude.requests[1].messages.at(-1).content[0].is_error).toBe(true);
  });

  it("crea el pedido contra entrega cuando el cliente confirma", async () => {
    const env = makeEnv();
    const calls = mockShopify();
    const claude = fakeClaude([toolUse("crear_pedido", ORDER), text("¡Listo! Tu pedido #1050 llega en 48 h.")]);
    const conv = { messages: [], updatedAt: Date.now() };
    const { reply, effects } = await runAgent(env, conv, "593911111111", undefined, "SÍ", claude);
    expect(reply).toContain("#1050");
    expect(effects.order).toEqual({ name: "#1050", total: "24.99", summary: "1 x Mini Cepillo Alisador Portátil", ciudad: "Quito" });
    const order = calls.find((c) => c.query.includes("orderCreate")).variables.order;
    expect(order.financialStatus).toBe("PENDING");
    expect(order.tags).toContain("contra-entrega");
    expect(order.lineItems[0]).toEqual({ variantId: "gid://shopify/ProductVariant/21", quantity: 1, priceSet: { shopMoney: { amount: "24.99", currencyCode: "USD" } } });
    expect(order.customAttributes).toContainEqual({ key: "Cédula", value: "1712345678" });
  });

  it("rechaza pedidos de más de 5 unidades", async () => {
    const env = makeEnv();
    const calls = mockShopify();
    const big = { ...ORDER, items: [{ variant_id: "gid://shopify/ProductVariant/10", quantity: 10 }] };
    const claude = fakeClaude([toolUse("crear_pedido", big), toolUse("escalar_a_luis", { motivo: "mayorista", resumen: "Quiere 10 frascos" }, "tu_2"), text("Te paso con Luis")]);
    const conv = { messages: [], updatedAt: Date.now() };
    const { effects } = await runAgent(env, conv, "593911111111", undefined, "sí", claude);
    expect(calls.some((c) => c.query.includes("orderCreate"))).toBe(false);
    expect(effects.escalation).toEqual({ motivo: "mayorista", resumen: "Quiere 10 frascos" });
  });

  it("escala si Claude rechaza el mensaje", async () => {
    const env = makeEnv();
    const claude = fakeClaude([{ stop_reason: "refusal", content: [] }]);
    const conv = { messages: [], updatedAt: Date.now() };
    const { reply, effects } = await runAgent(env, conv, "593911111111", undefined, "...", claude);
    expect(reply).toContain("Luis");
    expect(effects.escalation).toBeDefined();
  });
});
