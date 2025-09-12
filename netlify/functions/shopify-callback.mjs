// netlify/functions/shopify-callback.mjs
import crypto from "node:crypto";
import { logFnError } from "./log.mjs";

function parseCookies(header = "") {
  return Object.fromEntries(
    (header || "")
      .split(/; */)
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf("=");
        if (i === -1) return [c, ""];
        return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
      })
  );
}

const normShop = (s = "") =>
  String(s)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/\/.*/, "")
    .replace(/:\d+$/, "")
    .replace(/\.shopify\.com$/i, ".myshopify.com");

export const handler = async (event) => {
  const request_id = event.headers?.["x-nf-request-id"] || "";
  let shop = "";

  try {
    const API_KEY =
      process.env.SHOPIFY_API_KEY_PUBLIC || process.env.SHOPIFY_API_KEY || "";
    const SECRET =
      process.env.SHOPIFY_APP_SECRET_PUBLIC ||
      process.env.SHOPIFY_APP_SECRET ||
      "";
    const ONBOARD_URL = process.env.N8N_ONBOARD_SUBMIT_URL; // e.g. https://.../webhook/seoboss/api/onboarding/submit
    const PUBLIC_HMAC_KEY = process.env.PUBLIC_HMAC_KEY || ""; // must match your n8n validator/shared secret
    const FWD_SECRET = process.env.FORWARD_SECRET || "";

    if (!API_KEY || !SECRET)
      return { statusCode: 500, body: "missing API key/secret" };
    if (!ONBOARD_URL)
      return { statusCode: 500, body: "missing N8N_ONBOARD_SUBMIT_URL" };

    const url = new URL(event.rawUrl);
    const q = Object.fromEntries(url.searchParams.entries());
    const { shop: rawShop, hmac, code, state, timestamp } = q;

    // Validate shop + state
    shop = normShop(rawShop);
    const shopRe = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
    if (!shopRe.test(shop || ""))
      return { statusCode: 400, body: "invalid shop" };

    const cookies = parseCookies(
      event.headers?.cookie || event.headers?.Cookie || ""
    );
    if (!state || cookies.shopify_oauth_state !== state)
      return { statusCode: 401, body: "bad state" };

    // Replay + HMAC
    const ts = Number(timestamp || 0);
    if (!ts || Math.abs(Date.now() / 1000 - ts) > 600)
      return { statusCode: 401, body: "stale oauth" };
    if (!hmac || !code)
      return { statusCode: 400, body: "missing params" };

    const message = Object.keys(q)
      .filter((k) => k !== "hmac" && k !== "signature")
      .sort()
      .map((k) => `${k}=${q[k]}`)
      .join("&");

    const digest = crypto
      .createHmac("sha256", SECRET)
      .update(message)
      .digest("hex");
    const safe =
      hmac.length === digest.length &&
      crypto.timingSafeEqual(
        Buffer.from(hmac, "hex"),
        Buffer.from(digest, "hex")
      );
    if (!safe) return { statusCode: 401, body: "invalid hmac" };

    // OAuth code -> offline access token
    const tokenRes = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: API_KEY, client_secret: SECRET, code }),
      }
    );
    if (!tokenRes.ok) {
      const errTxt = await tokenRes.text();
      return { statusCode: 502, body: `token exchange failed: ${errTxt}` };
    }
    const { access_token /*, scope */ } = await tokenRes.json();

    // Hand off to YOUR onboarding flow (form-encoded, HMAC-signed)
    const bodyForm = new URLSearchParams({
      client_name: "",
      contact_email: "",
      default_language: "en",
      shop_input: shop, // your sanitize node expects this
      admin_token: access_token, // shpat_...
      tone: "",
      niche: "",
      seed_keywords: "",
      target_audience: "",
    }).toString();

    const ts2 = String(Math.floor(Date.now() / 1000));
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-SEOBOSS-FORWARD-SECRET": FWD_SECRET,
      "X-Seoboss-Ts": ts2,
      "X-Seoboss-Key-Id": "global",
    };
    if (PUBLIC_HMAC_KEY) {
      const sig = crypto
        .createHmac("sha256", PUBLIC_HMAC_KEY)
        .update(bodyForm + "\n" + ts2)
        .digest("hex");
      headers["X-Seoboss-Hmac"] = sig;
    }

    // Fire and forget (don’t block install)
    try {
      await fetch(ONBOARD_URL, { method: "POST", headers, body: bodyForm });
    } catch {
      /* ignore, we’ll still redirect */
    }

    // Redirect to connect page
    return {
      statusCode: 302,
      headers: {
        Location: `https://seoboss.com/pages/connect?shop=${encodeURIComponent(
          shop
        )}&installed=1`,
        "Set-Cookie":
          "shopify_oauth_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
      },
      body: "",
    };
  } catch (e) {
    // soft-fail + log
    try {
      await logFnError({
        fn: "shopify-callback",
        shop,
        status: e?.status || 500,
        message: e?.message || String(e),
        request_id,
        stack: e?.stack || null,
      });
    } catch {}

    return {
      statusCode: 302,
      headers: {
        Location: `https://seoboss.com/pages/connect?shop=${encodeURIComponent(
          shop || ""
        )}&installed=1`,
      },
      body: "",
    };
  }
};
