export interface Env {
  // Almacén de conversaciones (Cloudflare KV)
  STATE: KVNamespace;

  // WhatsApp por Kapso (coexistencia, plan gratis): clave de API, secreto del
  // webhook tipo "meta" y el phone number id (el mismo de Meta)
  KAPSO_API_KEY?: string;
  KAPSO_WEBHOOK_SECRET?: string;
  // WhatsApp por 360dialog (coexistencia): basta con la clave de la API
  D360_API_KEY?: string;
  // WhatsApp Cloud API directo de Meta (solo si no se usa 360dialog)
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_APP_SECRET?: string;
  GRAPH_API_VERSION?: string;
  // Clave que protege el webhook (y la verificación de Meta)
  WHATSAPP_VERIFY_TOKEN?: string;

  // Shopify Admin API
  SHOPIFY_STORE_DOMAIN: string; // p. ej. ritual-diario.myshopify.com
  SHOPIFY_CLIENT_ID?: string; // app del Dev Dashboard (client credentials grant)
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_ADMIN_TOKEN?: string; // solo para apps antiguas creadas en el admin
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
