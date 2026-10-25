export interface Env {
  // Almacén de conversaciones (Cloudflare KV)
  STATE: KVNamespace;

  // WhatsApp Cloud API (Meta)
  WHATSAPP_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_VERIFY_TOKEN: string;
  GRAPH_API_VERSION?: string;

  // Shopify Admin API
  SHOPIFY_STORE_DOMAIN: string; // p. ej. ritual-diario.myshopify.com
  SHOPIFY_ADMIN_TOKEN: string;
  SHOPIFY_API_VERSION?: string;
  STORE_URL: string; // p. ej. https://ritualdiarioec.store

  // Claude
  ANTHROPIC_API_KEY: string;
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: "low" | "medium" | "high";

  // Luis
  LUIS_PHONE: string; // número personal en formato internacional sin "+", p. ej. 593991234567
  ALERT_TEMPLATE?: string; // plantilla aprobada para avisos fuera de la ventana de 24 h
  ALERT_TEMPLATE_LANG?: string;
  PAUSE_HOURS?: string; // horas que el bot calla cuando Luis escribe desde la app
}
