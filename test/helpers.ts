import type { Env } from "../src/env";

export function memoryKV() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string, type?: string) {
      const v = data.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  } as unknown as KVNamespace & { data: Map<string, string> };
}

export function makeEnv(): Env & { STATE: ReturnType<typeof memoryKV> } {
  return {
    STATE: memoryKV(),
    WHATSAPP_TOKEN: "wa-token",
    WHATSAPP_PHONE_NUMBER_ID: "111",
    WHATSAPP_APP_SECRET: "secreto",
    WHATSAPP_VERIFY_TOKEN: "verificar",
    SHOPIFY_STORE_DOMAIN: "ritual.myshopify.com",
    SHOPIFY_ADMIN_TOKEN: "shp",
    STORE_URL: "https://ritualdiarioec.store",
    ANTHROPIC_API_KEY: "sk-test",
    LUIS_PHONE: "593990000000",
  };
}

export const CATALOG_RESPONSE = {
  data: {
    products: {
      nodes: [
        {
          id: "gid://shopify/Product/1",
          title: "NeoCell Colageno",
          handle: "neocell-colageno",
          productType: "Salud",
          description: "Colágeno hidrolizado en polvo, 20 g por porción.",
          variants: { nodes: [{ id: "gid://shopify/ProductVariant/10", title: "Default Title", price: "23.99", inventoryQuantity: 982 }] },
        },
        {
          id: "gid://shopify/Product/2",
          title: "Mini Cepillo Alisador Portátil",
          handle: "cepillo-alisador-portatil-jy-2692",
          productType: "Belleza",
          description: "Mini cepillo alisador recargable.",
          variants: {
            nodes: [
              { id: "gid://shopify/ProductVariant/20", title: "Negro", price: "24.99", inventoryQuantity: 300 },
              { id: "gid://shopify/ProductVariant/21", title: "Rosa", price: "24.99", inventoryQuantity: 296 },
            ],
          },
        },
      ],
    },
  },
};

// Cliente de Claude falso: devuelve las respuestas en orden y guarda las peticiones.
export function fakeClaude(responses: any[]) {
  const requests: any[] = [];
  return {
    requests,
    beta: {
      messages: {
        async create(params: any) {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("No hay más respuestas falsas");
          return next;
        },
      },
    },
  } as any;
}

export const text = (t: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });
export const toolUse = (name: string, input: unknown, id = "tu_1") => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id, name, input }],
});
