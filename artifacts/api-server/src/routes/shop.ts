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
const sessions = new Map<string, { user: any; guildId: string; expiresAt: number }>();
const oauthStates = new Map<string, { createdAt: number }>();
const SESSION_TTL = 24 * 60 * 60 * 1000;
const STATE_TTL = 10 * 60 * 1000;

function shopUrl() {
  return (process.env.FR_SHOP_ACTIVITY_URL?.trim() || "http://localhost:5173").replace(/\/$/, "");
}

function apiBase(req: Request) {
  return `${req.protocol}://${req.get("host")}`;
}

function sessionFrom(req: Request) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }
  return session;
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

    const sessionToken = crypto.randomBytes(32).toString("base64url");
    sessions.set(sessionToken, {
      user,
      guildId: String(selected.id),
      expiresAt: Date.now() + SESSION_TTL,
    });

    return res.json({
      session: sessionToken,
      access_token: String(token.access_token),
      user: {
        id: String(user.id),
        name: user.global_name || user.username || "Discord Kullanıcısı",
      },
      guildId: String(selected.id),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "activity_auth_failed" });
  }
});

router.get("/shop/auth/discord", (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return res.status(500).send("Discord OAuth için DISCORD_CLIENT_ID ve DISCORD_CLIENT_SECRET gerekli.");
  const state = crypto.randomBytes(24).toString("hex");
  oauthStates.set(state, { createdAt: Date.now() });
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
    const stateData = oauthStates.get(state);
    oauthStates.delete(state);
    if (!stateData || Date.now() - stateData.createdAt > STATE_TTL) return res.status(400).send("OAuth oturumu geçersiz veya süresi dolmuş.");
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

    const sessionToken = crypto.randomBytes(32).toString("base64url");
    sessions.set(sessionToken, { user, guildId: String(selected.id), expiresAt: Date.now() + SESSION_TTL });
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
    icon: "👑",
    description: "FR Family sunucusunda prestijli üst rol.",
    roleId: String(role.id),
  }));
  products.push(
    { id: "special-role", name: "Özel Rol", category: "Özel Rol", price: shopEffectivePrice(session.guildId, 10_000), icon: "🎨", description: "Sana özel bir rol talebi oluştur.", roleId: "" },
    { id: "nitro", name: "1 Aylık Discord Nitro", category: "Diğer Ürünler", price: shopEffectivePrice(session.guildId, 100_000), icon: "🎁", description: "Nitro siparişin manuel olarak teslim edilir.", roleId: "" },
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
  } else return res.status(404).json({ error: "product_not_found" });

  const order = await createShopOrder(session.guildId, session.user, product, price);
  if (!order) return res.status(400).json({ error: "insufficient_balance", balance: getShopCoins(session.guildId, String(session.user.id)), price });
  res.json({ balance: getShopCoins(session.guildId, String(session.user.id)), orderId: order.id, status: order.status });
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expiresAt < now) sessions.delete(k);
  for (const [k, v] of oauthStates) if (now - v.createdAt > STATE_TTL) oauthStates.delete(k);
}, 60_000).unref();

export default router;
