import { afterEach, describe, expect, it, vi } from "vitest";
import { getCatalog } from "../src/shopify";
import { CATALOG_RESPONSE, makeEnv } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("token de Shopify (client credentials)", () => {
  it("pide el token una vez, lo guarda y lo usa en la API", async () => {
    const env = makeEnv();
    delete env.SHOPIFY_ADMIN_TOKEN;
    env.SHOPIFY_CLIENT_ID = "cid";
    env.SHOPIFY_CLIENT_SECRET = "csecret";
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.endsWith("/admin/oauth/access_token")) return Response.json({ access_token: "tok123", scope: "read_products", expires_in: 86399 });
      return Response.json(CATALOG_RESPONSE);
    }));

    const catalog = await getCatalog(env);
    expect(catalog).toHaveLength(2);
    expect(catalog[0].variants[0].title).toBe("Única");

    const tokenCall = calls[0];
    expect(tokenCall.url).toBe("https://ritual.myshopify.com/admin/oauth/access_token");
    expect(String(tokenCall.init.body)).toBe("grant_type=client_credentials&client_id=cid&client_secret=csecret");
    expect(calls[1].init.headers["X-Shopify-Access-Token"]).toBe("tok123");

    // segunda lectura: el catálogo y el token salen de KV
    env.STATE.data.delete("catalog");
    await getCatalog(env);
    expect(calls.filter((c) => c.url.endsWith("/access_token"))).toHaveLength(1);
  });

  it("descarta el token guardado si Shopify niega el acceso", async () => {
    const env = makeEnv();
    delete env.SHOPIFY_ADMIN_TOKEN;
    env.SHOPIFY_CLIENT_ID = "cid";
    env.SHOPIFY_CLIENT_SECRET = "csecret";
    await env.STATE.put("shopify_token", "viejo");
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ errors: [{ message: "Access denied for products field.", extensions: { code: "ACCESS_DENIED" } }] }),
    ));
    await expect(getCatalog(env)).rejects.toThrow("ACCESS_DENIED");
    expect(env.STATE.data.has("shopify_token")).toBe(false);
  });
});
