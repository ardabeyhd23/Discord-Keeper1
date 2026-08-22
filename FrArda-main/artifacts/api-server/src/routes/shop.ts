import { Router, type Request } from "express";
import crypto from "node:crypto";
import {
  createShopOrder,
  createSupportTicket,
  addSupportMessage,
  getUserShopOrders,
  getUserCoinHistory,
  getUserSupportTickets,
  sendSupportMessageToOwner,
  discordApi,
  getShopCoins,
  recordShopLogin,
  getShopAdminSnapshot,
  FRARDA_OWNER_ID,
  loadShopState,
  shopEffectivePrice,
  shopPriceForRole,
  shopRoles,
  SHOP_BASE_PRODUCTS,
  getShopProductOverrides,
  getShopProductOverride,
  upsertShopProduct,
  deleteShopProduct,
} from "../bot";

const router = Router();
const SESSION_TTL = 24 * 60 * 60 * 1000;
const STATE_TTL = 10 * 60 * 1000;
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

function isFrArdaOwner(session: ReturnType<typeof sessionFrom>) {
  return Boolean(session && String(session.user.id) === FRARDA_OWNER_ID);
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
    await recordShopLogin(String(selected.id), user);

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
    await recordShopLogin(String(selected.id), user);
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
  await recordShopLogin(session.guildId, session.user);
  const roles = await shopRoles(session.guildId);
  const override = (product: any) => ({ ...product, ...(getShopProductOverride(session.guildId, product.id) ?? {}) });
  const products = roles.map((role: any) => override({
    id: `role:${role.id}`,
    name: String(role.name),
    category: "Roller",
    price: shopEffectivePrice(session.guildId, shopPriceForRole(role, session.guildId)),
    icon: "crown-purple",
    description: "FR Family sunucusunda satın alınabilir rol.",
    roleId: String(role.id),
  })).filter((product: any) => product.active !== false);
  products.push(
    override({ id: "special-role", name: "Özel Rol", category: "Özel Rol", price: shopEffectivePrice(session.guildId, 10_000), icon: "role-pink", description: "Sana özel bir rol talebi oluştur.", roleId: "" }),
    ...SHOP_BASE_PRODUCTS.map((item) => override({ ...item, price: shopEffectivePrice(session.guildId, item.price), roleId: "" })).filter((product: any) => product.active !== false),
    ...getShopProductOverrides(session.guildId).filter((item) => !item.id.startsWith("role:") && !SHOP_BASE_PRODUCTS.some((base) => base.id === item.id) && item.id !== "special-role" && item.active !== false),
  );
  const balance = getShopCoins(session.guildId, String(session.user.id));
  const campaignActive = Boolean(shopEffectivePrice(session.guildId, 100) < 100);
  res.json({
    products,
    balance,
    campaign: campaignActive ? { discount: getShopAdminSnapshot(session.guildId).activeCampaign?.discount ?? 0, expiresAt: getShopAdminSnapshot(session.guildId).activeCampaign?.expiresAt ?? null } : null,
    user: { id: String(session.user.id), isOwner: isFrArdaOwner(session), name: session.user.global_name || session.user.username || "Discord Kullanıcısı", tag: `@${session.user.username || "discord-user"}`, avatar: session.user.avatar ? `https://cdn.discordapp.com/avatars/${session.user.id}/${session.user.avatar}.png?size=128` : "🧑‍🚀" },
    guild: { id: session.guildId, name: "Discord Sunucusu" },
  });
});

router.get("/shop/admin", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  if (!isFrArdaOwner(session)) return res.status(403).json({ error: "owner_only" });
  await loadShopState();
  const roles = await shopRoles(session.guildId);
  const roleProducts = roles.map((role: any) => {
    const id = `role:${role.id}`;
    const saved = getShopProductOverride(session.guildId, id);
    return {
      id,
      roleId: String(role.id),
      name: String(saved?.name ?? role.name),
      category: String(saved?.category ?? "Roller"),
      price: Number(saved?.price ?? shopPriceForRole(role, session.guildId)),
      icon: String(saved?.icon ?? "crown-purple"),
      description: String(saved?.description ?? "FR Family sunucusunda satın alınabilir rol."),
      imageUrl: saved?.imageUrl ?? "",
      active: saved?.active !== false,
    };
  });
  const baseProducts = SHOP_BASE_PRODUCTS.map((item) => ({ ...item, ...(getShopProductOverride(session.guildId, item.id) ?? {}) }));
  const customProducts = getShopProductOverrides(session.guildId).filter((item) => !item.id.startsWith("role:") && !SHOP_BASE_PRODUCTS.some((base) => base.id === item.id) && item.id !== "special-role");
  res.json({ ...getShopAdminSnapshot(session.guildId), products: [
    { id: "special-role", name: "Özel Rol", category: "Özel Rol", price: 10_000, icon: "role-pink", description: "Sana özel rol talebi.", active: true, ...(getShopProductOverride(session.guildId, "special-role") ?? {}) },
    ...baseProducts,
    ...customProducts,
    ...roleProducts,
  ], roles: roles.map((role: any) => ({ id: String(role.id), name: String(role.name), position: Number(role.position ?? 0) })) });
});

router.put("/shop/admin/products", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  if (!isFrArdaOwner(session)) return res.status(403).json({ error: "owner_only" });
  await loadShopState();
  const body = req.body ?? {};
  const id = String(body.id ?? "").trim() || `custom-${Date.now().toString(36)}`;
  if (!String(body.name ?? "").trim() || !String(body.category ?? "").trim()) return res.status(400).json({ error: "name_and_category_required" });
  const product = await upsertShopProduct(session.guildId, {
    id,
    name: String(body.name),
    category: String(body.category),
    price: Number(body.price),
    icon: String(body.icon || "crown-purple"),
    description: String(body.description || ""),
    imageUrl: String(body.imageUrl || "").trim(),
    featured: Boolean(body.featured),
    roleId: String(body.roleId || "").trim() || undefined,
    active: body.active !== false,
  });
  res.json({ product });
});

router.delete("/shop/admin/products/:productId", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  if (!isFrArdaOwner(session)) return res.status(403).json({ error: "owner_only" });
  await loadShopState();
  const deleted = await deleteShopProduct(session.guildId, req.params.productId);
  res.json({ deleted });
});

router.get("/shop/orders", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  await loadShopState();
  res.json({ orders: getUserShopOrders(session.guildId, String(session.user.id)) });
});

router.get("/shop/coin-history", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  await loadShopState();
  res.json({ entries: getUserCoinHistory(session.guildId, String(session.user.id)) });
});

router.get("/shop/support", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  // Support conversations are private per Discord user. Prevent a cached
  // response from appearing when the Activity is opened by another account.
  res.setHeader("Cache-Control", "no-store, private");
  await loadShopState();
  res.json({ tickets: getUserSupportTickets(session.guildId, String(session.user.id)) });
});

router.post("/shop/support", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  const subject = String(req.body?.subject || "").trim();
  if (subject.length < 5) return res.status(400).json({ error: "subject_too_short" });
  try {
    const ticket = await createSupportTicket(session.guildId, session.user, subject);
    res.json({ ticket });
  } catch (error) {
    res.status(500).json({ error: "support_create_failed", message: error instanceof Error ? error.message : "unknown_error" });
  }
});

router.post("/shop/support/:ticketId/messages", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  res.setHeader("Cache-Control", "no-store, private");
  const body = String(req.body?.body || "").trim();
  const ticket = getUserSupportTickets(session.guildId, String(session.user.id)).find((item) => item.id === req.params.ticketId);
  if (!ticket || ticket.status !== "acik") return res.status(400).json({ error: "ticket_not_open" });
  if (body.length < 1) return res.status(400).json({ error: "message_empty" });
  const updated = await addSupportMessage(ticket.id, String(session.user.id), ticket.username, body);
  if (!updated) return res.status(400).json({ error: "ticket_closed" });
  await sendSupportMessageToOwner(updated, body);
  res.json({ ticket: updated });
});

router.post("/shop/purchase", async (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.status(401).json({ error: "unauthorized", loginUrl: `${apiBase(req)}/api/shop/auth/discord` });
  const productId = String(req.body?.productId || "");
  await loadShopState();
  let product = "";
  let price = 0;
  let roleId = "";
  if (productId.startsWith("role:")) {
    const selectedRoleId = productId.slice(5);
    const roles = await shopRoles(session.guildId);
    const role = roles.find((r: any) => String(r.id) === selectedRoleId);
    if (!role) return res.status(404).json({ error: "product_not_found" });
    const saved = getShopProductOverride(session.guildId, productId);
    product = String(saved?.name ?? role.name);
    price = shopEffectivePrice(session.guildId, Number(saved?.price ?? shopPriceForRole(role, session.guildId)));
    roleId = String(role.id);
  } else {
    const base = productId === "special-role"
      ? { id: "special-role", name: "Özel Rol", price: 10_000 }
      : SHOP_BASE_PRODUCTS.find((item) => item.id === productId);
    const custom = getShopProductOverrides(session.guildId).find((item) => item.id === productId);
    const selected = { ...base, ...custom } as any;
    if (!selected.id || selected.active === false) return res.status(404).json({ error: "product_not_found" });
    product = String(selected.name);
    price = shopEffectivePrice(session.guildId, Number(selected.price));
    roleId = String(selected.roleId || "");
  }

  const order = await createShopOrder(session.guildId, session.user, product, price, { roleId: roleId || undefined });
  if (!order) return res.status(400).json({ error: "insufficient_balance", balance: getShopCoins(session.guildId, String(session.user.id)), price });
  res.json({ balance: getShopCoins(session.guildId, String(session.user.id)), orderId: order.id, status: order.status });
});

export default router;
