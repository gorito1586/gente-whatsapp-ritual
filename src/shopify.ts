import type { Env } from "./env";

export interface Variant {
  id: string;
  title: string;
  price: string;
  stock: number;
}

export interface Product {
  id: string;
  title: string;
  url: string;
  type: string;
  description: string;
  variants: Variant[];
}

async function admin(env: Env, query: string, variables: Record<string, unknown> = {}) {
  const version = env.SHOPIFY_API_VERSION ?? "2026-07";
  const res = await fetch(`https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.errors) throw new Error(`Shopify ${res.status}: ${JSON.stringify(data.errors ?? data)}`);
  return data.data;
}

const PRODUCTS_QUERY = `query {
  products(first: 50, query: "status:active") {
    nodes {
      id title handle productType description
      variants(first: 20) { nodes { id title price inventoryQuantity } }
    }
  }
}`;

// El catálogo es pequeño: se lee completo y se guarda 5 minutos en KV.
export async function getCatalog(env: Env): Promise<Product[]> {
  const cached = await env.STATE.get<Product[]>("catalog", "json");
  if (cached) return cached;
  const data = await admin(env, PRODUCTS_QUERY);
  const products: Product[] = data.products.nodes.map((p: any) => ({
    id: p.id,
    title: p.title,
    url: `${env.STORE_URL}/products/${p.handle}`,
    type: p.productType,
    description: p.description,
    variants: p.variants.nodes.map((v: any) => ({
      id: v.id,
      title: v.title === "Default Title" ? "Única" : v.title,
      price: v.price,
      stock: v.inventoryQuantity ?? 0,
    })),
  }));
  await env.STATE.put("catalog", JSON.stringify(products), { expirationTtl: 300 });
  return products;
}

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function searchCatalog(catalog: Product[], text?: string): Product[] {
  if (!text?.trim()) return catalog;
  const words = normalize(text).split(/\s+/).filter((w) => w.length > 2);
  const hits = catalog.filter((p) => {
    const hay = normalize(`${p.title} ${p.type} ${p.description}`);
    return words.some((w) => hay.includes(w));
  });
  // Si no hay coincidencias, se devuelve todo para que Claude ofrezca algo parecido.
  return hits.length ? hits : catalog;
}

export interface OrderInput {
  items: { variant_id: string; quantity: number }[];
  nombre: string;
  apellido: string;
  cedula: string;
  telefono: string;
  provincia: string;
  ciudad: string;
  direccion: string;
  referencia: string;
}

const ORDER_MUTATION = `mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { id name totalPriceSet { shopMoney { amount } } }
    userErrors { field message }
  }
}`;

export async function createOrder(env: Env, input: OrderInput, whatsapp: string) {
  const catalog = await getCatalog(env);
  const variants = new Map(catalog.flatMap((p) => p.variants.map((v) => [v.id, { ...v, product: p.title }])));

  const lineItems = input.items.map((item) => {
    const v = variants.get(item.variant_id);
    if (!v) throw new Error(`La variante ${item.variant_id} no existe en el catálogo.`);
    return {
      variantId: v.id,
      quantity: item.quantity,
      priceSet: { shopMoney: { amount: v.price, currencyCode: "USD" } },
    };
  });

  const address = {
    firstName: input.nombre,
    lastName: input.apellido,
    address1: input.direccion,
    address2: `Ref: ${input.referencia} · Provincia: ${input.provincia}`,
    city: input.ciudad,
    countryCode: "EC",
    phone: input.telefono,
  };

  const data = await admin(env, ORDER_MUTATION, {
    order: {
      lineItems,
      shippingAddress: address,
      billingAddress: address,
      phone: input.telefono,
      financialStatus: "PENDING",
      currency: "USD",
      tags: ["whatsapp", "contra-entrega"],
      sourceName: "whatsapp-agente",
      note: `Pedido tomado por el agente de WhatsApp (+${whatsapp}). Pago contra entrega.`,
      customAttributes: [
        { key: "Cédula", value: input.cedula },
        { key: "WhatsApp", value: `+${whatsapp}` },
      ],
    },
    options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: false },
  });

  const result = data.orderCreate;
  if (result.userErrors?.length) throw new Error(result.userErrors.map((e: any) => e.message).join("; "));
  return {
    name: result.order.name as string,
    total: result.order.totalPriceSet.shopMoney.amount as string,
    summary: input.items
      .map((i) => `${i.quantity} x ${variants.get(i.variant_id)!.product}`)
      .join(", "),
  };
}
