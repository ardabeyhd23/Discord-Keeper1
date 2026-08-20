import { Router, type Request } from "express";
import crypto from "node:crypto";
import {
  createShopOrder,
  discordApi,
  getShopCoins,
  loadShopState,
  shopEffectivePrice,
  shopPriceForRole,
  shopRoles,
} from "../bot";

const router = Router();
const SESSION_TTL = 24 * 60 * 60 * 1000;
const STATE_TTL = 10 * 60 * 1000;
const ROBUX_PRODUCTS = [
  { id: "robux-100", name: "100 Robux", price: 10000, icon: "robux", description: "Roblox hesabına 100 Robux siparişi." },
  { id: "robux-500", name: "500 Robux", price: 40000, icon: "robux", description: "Roblox hesabına 500 Robux siparişi." },
  { id: "robux-1000", name: "1.000 Robux", price: 75000, icon: "robux", description: "Roblox hesabına 1.000 Robux siparişi." },
  { id: "robux-2500", name: "2.500 Robux", price: 150000, icon: "robux", description: "Roblox hesabına 2.500 Robux siparişi." },
] as const;

// OAuth state must survive Render hibernation/restarts. Keep it self-contained
// and signed instead of storing it only in process memory.
function oauthStateSecret() {
  return process.env.DISCORD_CLIENT_SECRET?.trim() || "";
}

function createOAuthState() {
  const payload = `${Date.now()}.${crypto.randomBytes(24).toString("hex")}`;
  const secret = oauthStateSecret();
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyOAuthState(state: string) {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [createdAtRaw, nonce, signature] = parts;
  const createdAt = Number(createdAtRaw);
  const secret = oauthStateSecret();
  if (!secret || !createdAt || !nonce || !signature) return false;
  if (Date.now() - createdAt < 0 || Date.now() - createdAt > STATE_TTL) return false;
  const payload = `${createdAtRaw}.${nonce}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function shopUrl() {
  return (process.env.FR_SHOP_ACTIVITY_URL?.trim() || "http://localhost:5173").replace(/\/$/, "");
}

function apiBase(req: Request) {
  return `${req.protocol}://${req.get("host")}`;
}

function createSession(user: any, guildId: string) {
  const payload = JSON.stringify({
    user,
    guildId: String(guildId),
    expiresAt: Date.now() + SESSION_TTL,
  });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const secret = oauthStateSecret();
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function sessionFrom(req: Request) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  const secret = oauthStateSecret();
  if (!encoded || !signature || !secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!session?.user?.id || !session?.guildId || Number(session.expiresAt) < Date.now()) return null;
    return session as { user: any; guildId: string; expiresAt: number };
  } catch {
    return null;
  }
}

async function discordOAuth(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(init.headers || {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Discord OAuth ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function redirectUri(req: Request) {
  return process.env.FR_SHOP_OAUTH_REDIRECT_URI?.trim() || `${apiBase(req)}/api/shop/auth/callback`;
}

router.post("/shop/auth/activity", async (req, res) => {
  try {
    const clientId = process.env.DISCORD_CLIENT_ID?.trim();
    const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
    const code = String(req.body?.code || "");
    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: "discord_oauth_not_configured" });
    }
    if (!code) return res.status(400).json({ error: "missing_code" });

    const token = await discordOAuth("/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
      }),
    });

    const user = await discordOAuth("/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const userGuilds = await discordOAuth("/users/@me/guilds", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const botGuilds = await discordApi("/users/@me/guilds");
    const botIds = new Set(
      Array.isArray(botGuilds) ? botGuilds.map((g: any) => String(g.id)) : [],
    );
    const candidates = (Array.isArray(userGuilds) ? userGuilds : []).filter(
      (g: any) => botIds.has(String(g.id)),
    );
    const configured = process.env.FR_SHOP_GUILD_ID?.trim();
    const selected = configured
      ? candidates.find((g: any) => String(g.id) === configured)
      : candidates[0];

    if (!selected) {
      return res.status(403).json({
        error: "no_shop_guild",
        message: "Bu Discord hesabının botun bulunduğu bir sunucuda mağaza erişimi yok.",
      });
    }

    const sessionToken = createSession(user, String(selected.id));

    return res.json({
      session: sessionToken,
      access_token: String(token.access_token),
      user: {
        id: String(user.id),
        name: user.global_name || user.username || "Discord Kullanıcısı",
        tag: `@${user.username || "discord-user"}`,
        avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : "",
      },
      guildId: String(selected.id),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "activity_auth_failed", message: error instanceof Error ? error.message : "unknown_error" });
  }
});

router.get("/shop/auth/discord", (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return res.status(500).send("Discord OAuth için DISCORD_CLIENT_ID ve DISCORD_CLIENT_SECRET gerekli.");
  const state = createOAuthState();
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri(req));
  url.searchParams.set("scope", "identify guilds");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

router.get("/shop/auth/callback", async (req, res) => {
  try {
    const state = String(req.query.state || "");
    if (!verifyOAuthState(state)) return res.status(400).send("OAuth oturumu geçersiz veya süresi dolmuş.");
    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Discord yetkilendirme kodu bulunamadı.");

    const token = await discordOAuth("/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID!.trim(),
        client_secret: process.env.DISCORD_CLIENT_SECRET!.trim(),
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(req),
      }),
    });
    const user = await discordOAuth("/users/@me", { headers: { Authorization: `Bearer ${token.access_token}` } });
    const userGuilds = await discordOAuth("/users/@me/guilds", { headers: { Authorization: `Bearer ${token.access_token}` } });
    const botGuilds = await discordApi("/users/@me/guilds");
    const botIds = new Set(Array.isArray(botGuilds) ? botGuilds.map((g: any) => String(g.id)) : []);
    const candidates = (Array.isArray(userGuilds) ? userGuilds : []).filter((g: any) => botIds.has(String(g.id)));
    const configured = process.env.FR_SHOP_GUILD_ID?.trim();
    const selected = configured ? candidates.find((g: any) => String(g.id) === configured) : candidates[0];
    if (!selected) return res.status(403).send("Bu Discord hesabının botun bulunduğu bir sunucuda mağaza erişimi yok.");

    const sessionToken = createSession(user, String(selected.id));
    res.redirect(`${shopUrl()}/#session=${encodeURIComponent(sessionToken)}`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Discord ile giriş sırasında hata oluştu.");
  }
});

router.get("/shop/catalog", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ loginUrl: `${apiBase(req)}/api/shop/auth/discord` });
  await loadShopState();
  const roles = await shopRoles(session.guildId);
  const products = roles.map((role: any) => ({
    id: `role:${role.id}`,
    name: String(role.name),
    category: "Üst Roller",
    price: shopEffectivePrice(session.guildId, shopPriceForRole(role, session.guildId)),
    icon: "crown-purple",
    description: "FR Family sunucusunda prestijli üst rol.",
    roleId: String(role.id),
  }));
  products.push(
    { id: "special-role", name: "Özel Rol", category: "Özel Rol", price: shopEffectivePrice(session.guildId, 10_000), icon: "role-pink", description: "Sana özel bir rol talebi oluştur.", roleId: "" },
    { id: "nitro", name: "1 Aylık Discord Nitro", category: "Diğer Ürünler", price: shopEffectivePrice(session.guildId, 100_000), icon: "nitro-blue", description: "Nitro siparişin manuel olarak teslim edilir.", roleId: "" },
    ...ROBUX_PRODUCTS.map((item) => ({ ...item, category: "Robux", price: shopEffectivePrice(session.guildId, item.price), roleId: "" })),
  );
  const balance = getShopCoins(session.guildId, String(session.user.id));
  res.json({ products, balance, user: { name: session.user.global_name || session.user.username || "Discord Kullanıcısı", tag: `@${session.user.username || "discord-user"}`, avatar: session.user.avatar ? `https://cdn.discordapp.com/avatars/${session.user.id}/${session.user.avatar}.png?size=128` : "🧑‍🚀" }, guild: { id: session.guildId, name: "Discord Sunucusu" } });
});

router.post("/shop/purchase", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ error: "unauthorized", loginUrl: `${apiBase(req)}/api/shop/auth/discord` });
  const productId = String(req.body?.productId || "");
  await loadShopState();
  let product = "";
  let price = 0;
  if (productId.startsWith("role:")) {
    const roleId = productId.slice(5);
    const roles = await shopRoles(session.guildId);
    const role = roles.find((r: any) => String(r.id) === roleId);
    if (!role) return res.status(404).json({ error: "product_not_found" });
    product = `Üst Rol: ${String(role.name)}`;
    price = shopEffectivePrice(session.guildId, shopPriceForRole(role, session.guildId));
  } else if (productId === "special-role") {
    product = "Özel Rol";
    price = shopEffectivePrice(session.guildId, 10_000);
  } else if (productId === "nitro") {
    product = "1 Aylık Discord Nitro";
    price = shopEffectivePrice(session.guildId, 100_000);
  } else {
    const robux = ROBUX_PRODUCTS.find((item) => item.id === productId);
    if (!robux) return res.status(404).json({ error: "product_not_found" });
    product = robux.name;
    price = shopEffectivePrice(session.guildId, robux.price);
  }

  const order = await createShopOrder(session.guildId, session.user, product, price);
  if (!order) return res.status(400).json({ error: "insufficient_balance", balance: getShopCoins(session.guildId, String(session.user.id)), price });
  res.json({ balance: getShopCoins(session.guildId, String(session.user.id)), orderId: order.id, status: order.status });
});

export default router;
