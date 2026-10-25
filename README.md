# Agente de WhatsApp · Ritual Diario

Asistente que responde por WhatsApp Business a los clientes de [Ritual Diario](https://ritualdiarioec.store): informa sobre productos con el catálogo en vivo de Shopify, toma pedidos contra entrega y pasa a Luis los casos difíciles.

## Cómo funciona

```
Cliente en WhatsApp ──▶ WhatsApp Cloud API (coexistencia) ──webhook──▶ Cloudflare Worker
                                                                         │
                                         ┌───────────────────────────────┼──────────────────────┐
                                         ▼                               ▼                      ▼
                                 Shopify Admin API               Claude (Anthropic)     Aviso a Luis por WhatsApp
                              (catálogo, crear pedido)        (responde y decide)      (casos difíciles y pedidos)
```

- **Catálogo:** se lee de Shopify (productos activos) y se guarda 5 minutos.
- **Pedidos:** el agente pide los datos, muestra el resumen y solo crea el pedido si el último mensaje del cliente es un "SÍ". Se crea en Shopify como pago pendiente, con las etiquetas `whatsapp` y `contra-entrega`; de ahí pasa a Dropi. Máximo 5 unidades; más que eso se escala.
- **Escalado:** reclamos, garantía, salud, mayoristas, descuentos, clientes molestos o lo que el agente no sepa. Luis recibe un aviso y el bot deja de responder en ese chat.
- **Coexistencia:** si Luis escribe a un cliente desde la app WhatsApp Business, el bot se calla en ese chat durante `PAUSE_HOURS` horas (12 por defecto).

### Comandos de Luis

Desde su WhatsApp personal (`LUIS_PHONE`) al número del negocio:

| Mensaje | Efecto |
|---|---|
| `activar 593991234567` | El bot vuelve a atender ese chat |
| `pausar 593991234567` | El bot deja de atender ese chat |

## Archivos

| Archivo | Qué hace |
|---|---|
| `src/prompt.ts` | Instrucciones del agente: tono, políticas de envío, pago y garantía, reglas de escalado |
| `src/agent.ts` | Conversación con Claude y herramientas (`buscar_productos`, `crear_pedido`, `escalar_a_luis`) |
| `src/shopify.ts` | Lectura del catálogo y creación de pedidos |
| `src/whatsapp.ts` | Webhook, firma de Meta y envío de mensajes |
| `src/index.ts` | Punto de entrada, pausas y comandos de Luis |

## Puesta en marcha

1. **Cloudflare:** crea una cuenta gratis, luego:
   ```bash
   npm install
   npx wrangler login
   npx wrangler kv namespace create STATE   # copia el id en wrangler.toml
   ```
2. **Shopify:** desde 2026 las apps nuevas se crean en el [Dev Dashboard](https://dev.shopify.com/dashboard) (ya no en *Desarrollar apps* del admin). Crea una app, en su versión marca los permisos `read_products`, `read_inventory` y `write_orders`, publícala e instálala en la tienda. Copia el *Client ID* y el *Client secret*; el agente pide solo el token de 24 h con ellos.
3. **Anthropic:** crea una clave en [console.anthropic.com](https://console.anthropic.com).
4. **Meta / WhatsApp:**
   - En [developers.facebook.com](https://developers.facebook.com) crea una app tipo *Business* y agrega el producto *WhatsApp*.
   - Conecta el número de Ritual Diario en modo **coexistencia** (escaneando el código QR desde la app WhatsApp Business).
   - Crea un usuario de sistema con token permanente y permisos `whatsapp_business_messaging` y `whatsapp_business_management`.
   - Copia el *Phone number ID* y el *App secret*.
5. **Secretos:**
   ```bash
   npx wrangler secret put WHATSAPP_TOKEN
   npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
   npx wrangler secret put WHATSAPP_APP_SECRET
   npx wrangler secret put WHATSAPP_VERIFY_TOKEN     # una clave que tú inventas
   npx wrangler secret put SHOPIFY_STORE_DOMAIN      # xxxx.myshopify.com
   npx wrangler secret put SHOPIFY_CLIENT_ID
   npx wrangler secret put SHOPIFY_CLIENT_SECRET
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put LUIS_PHONE                # 5939XXXXXXXX
   ```
6. **Publicar:** `npm run deploy`. En Meta, configura el webhook con la URL `https://gente-whatsapp-ritual.slipluis.workers.dev/webhook`, el mismo `WHATSAPP_VERIFY_TOKEN`, y suscríbete a los campos `messages` y `smb_message_echoes`.

### Avisos a Luis fuera de la ventana de 24 horas

WhatsApp solo permite mensajes libres a un número que escribió al negocio en las últimas 24 horas. Para que los avisos lleguen siempre, crea en Meta una plantilla de categoría *Utilidad* (por ejemplo `aviso_luis`, idioma español) con el cuerpo `{{1}}`, y cuando esté aprobada:

```bash
npx wrangler secret put ALERT_TEMPLATE        # aviso_luis
```

Mientras tanto, basta con que Luis escriba cualquier cosa al número del negocio una vez al día.

## Modelo de Claude

Por defecto usa `claude-opus-5-5` con esfuerzo `low`, que es rápido y suficiente para atención al cliente. Para bajar costos se puede probar `claude-haiku-5-5` cambiando `CLAUDE_MODEL` en `wrangler.toml`.

## Revisar la configuración

Abre `https://gente-whatsapp-ritual.slipluis.workers.dev/salud`: muestra qué secretos faltan y si Shopify responde.

## Pruebas

```bash
npm test          # pruebas automáticas (sin llamar a servicios reales)
npm run typecheck
```

Antes de abrirlo a clientes, prueba con tu propio número: pregunta precios, haz un pedido de prueba (y cancélalo en Shopify) y verifica que llegue a Dropi, y provoca un escalado escribiendo "quiero hablar con una persona".
