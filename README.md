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
4. **WhatsApp con 360dialog (coexistencia):** Meta solo permite la coexistencia a través de proveedores oficiales, así que se usa [360dialog](https://360dialog.com).
   - Crea la cuenta en 360dialog y conecta el número de Ritual Diario eligiendo la opción de **coexistencia** (se escanea un QR desde la app WhatsApp Business).
   - En el panel de 360dialog genera la **API key** del número.
5. **Secretos** (en Cloudflare → *Settings → Variables and Secrets*, tipo *Secret*):
   - `D360_API_KEY`: la API key de 360dialog
   - `WHATSAPP_VERIFY_TOKEN`: una clave larga que tú inventas (protege el webhook)
   - `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`
   - `ANTHROPIC_API_KEY`
   - `LUIS_PHONE`: tu número personal, p. ej. `593991234567`
6. **Conectar el webhook:** abre una vez en el navegador
   `https://gente-whatsapp-ritual.slipluis.workers.dev/configurar-webhook?clave=TU_WHATSAPP_VERIFY_TOKEN`.
   Registra en 360dialog la dirección `/webhook` con una cabecera secreta. La respuesta debe mostrar `"status": 200`.

> También funciona con la Cloud API directa de Meta (sin coexistencia): en vez de `D360_API_KEY` se cargan `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` y `WHATSAPP_APP_SECRET`, y el webhook se configura en Meta con la URL `/webhook` y el mismo `WHATSAPP_VERIFY_TOKEN`.

### Avisos a Luis fuera de la ventana de 24 horas

WhatsApp solo permite mensajes libres a un número que escribió al negocio en las últimas 24 horas. Para que los avisos lleguen siempre, crea (en el panel de 360dialog) una plantilla de categoría *Utilidad* (por ejemplo `aviso_luis`, idioma español) con el cuerpo `{{1}}`, y cuando esté aprobada:

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
