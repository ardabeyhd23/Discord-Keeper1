import { useEffect, useMemo, useState } from "react";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import "./styles.css";
import "./icon-overrides.css";

type Product = { id: string; name: string; category: string; price: number; icon: string; description: string; featured?: boolean; roleId?: string };
type User = { id?: string; name: string; tag: string; avatar?: string; guildName?: string; };

const demoProducts: Product[] = [
  { id: "emperor", name: "FR | EMPEROR", category: "Üst Roller", price: 50000, icon: "crown-gold", description: "Sunucunun en prestijli rolü.", featured: true },
  { id: "king", name: "FR | KING", category: "Üst Roller", price: 40000, icon: "crown-purple", description: "Gücünü ve tarzını göster." },
  { id: "elite", name: "FR | ELİTE", category: "Üst Roller", price: 30000, icon: "diamond-blue", description: "Özel topluluğun seçimi." },
  { id: "vip", name: "FR | VİP", category: "Üst Roller", price: 15000, icon: "bolt-violet", description: "VIP ayrıcalıklarla öne çık." },
  { id: "custom", name: "Özel Rol", category: "Özel Rol", price: 25000, icon: "role-pink", description: "Sana özel bir rol talep et." },
  { id: "nitro", name: "1 Aylık Discord Nitro", category: "Diğer Ürünler", price: 100000, icon: "nitro-blue", description: "Nitro siparişin manuel olarak teslim edilir." },
  { id: "robux-100", name: "100 Robux", category: "Robux", price: 10000, icon: "robux-red", description: "Roblox hesabına 100 Robux siparişi." },
  { id: "robux-500", name: "500 Robux", category: "Robux", price: 40000, icon: "robux-red", description: "Roblox hesabına 500 Robux siparişi." },
  { id: "robux-1000", name: "1.000 Robux", category: "Robux", price: 75000, icon: "robux-gold", description: "Roblox hesabına 1.000 Robux siparişi." },
  { id: "robux-2500", name: "2.500 Robux", category: "Robux", price: 150000, icon: "robux-gold", description: "Roblox hesabına 2.500 Robux siparişi." },
];

const money = (n: number) => `${n.toLocaleString("tr-TR")} Coin`;
// In an Activity, keep API calls relative so Discord's URL Mapping/proxy handles them.
// An absolute Render URL can bypass the Activity proxy and be blocked by the embedded CSP.
const api = "";
const discordClientId = String(import.meta.env.VITE_DISCORD_CLIENT_ID || "1535760848407232603");
const isDiscordActivity = typeof window !== "undefined" && window.parent !== window;

function ProductIcon({ icon }: { icon: string }) {
  const text = icon.includes("robux") ? "R$" : icon.includes("crown") ? "FR" : icon.includes("diamond") ? "◆" : icon.includes("bolt") ? "F" : icon.includes("nitro") ? "N" : "✦";
  return <span className={`product-icon icon-${icon}`} aria-hidden="true"><i>{text}</i></span>;
}

export default function App() {
  const [products, setProducts] = useState<Product[]>(demoProducts);
  const [balance, setBalance] = useState(0);
  const [category, setCategory] = useState("Tümü");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Product | null>(null);
  const [toast, setToast] = useState("");
  const [session, setSession] = useState(() => sessionStorage.getItem("fr_shop_session") || "");
  const [user, setUser] = useState<User>({ name: "Discord Kullanıcısı", tag: "@discord-user" });
  const [activityError, setActivityError] = useState("");
  const [loading, setLoading] = useState(true);

  const loadCatalog = async (token: string) => {
    const response = await fetch(`${api}/api/shop/catalog`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "include",
    });
    if (response.status === 401) throw new Error("unauthorized");
    if (!response.ok) throw new Error("catalog");
    const data = await response.json();
    setProducts(data.products || demoProducts);
    setBalance(Number(data.balance || 0));
    if (data.user) setUser(data.user);
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    const setupActivity = async () => {
      if (!isDiscordActivity) { setLoading(false); return; }
      try {
        const discordSdk = new DiscordSDK(discordClientId);
        await discordSdk.ready();
        const { code } = await discordSdk.commands.authorize({
          client_id: discordClientId,
          response_type: "code",
          state: "",
          prompt: "none",
          scope: ["identify", "guilds", "applications.commands"],
        });
        const response = await fetch("/api/shop/auth/activity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.access_token || !data.session) {
          throw new Error(data.message || data.error || "activity_auth");
        }
        await discordSdk.commands.authenticate({ access_token: data.access_token });
        if (cancelled) return;
        sessionStorage.setItem("fr_shop_session", data.session);
        setSession(data.session);
        if (data.user) setUser(data.user);
        setActivityError("");
        await loadCatalog(data.session);
      } catch (error) {
        console.error("FR Activity initialization failed", error);
        if (!cancelled) {
          setLoading(false);
          setActivityError(error instanceof Error ? error.message : "Discord oturumu başlatılamadı.");
        }
      }
    };
    void setupActivity();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (isDiscordActivity) return;
    const load = async () => {
      try { await loadCatalog(session); }
      catch (error) {
        setLoading(false);
        if (error instanceof Error && error.message === "unauthorized") {
          const response = await fetch(`${api}/api/shop/auth/discord`);
          if (response.redirected) window.location.href = response.url;
        }
      }
    };
    void load();
  }, [session]);

  const categories = ["Tümü", ...Array.from(new Set(products.map((p) => p.category)))];
  const visible = useMemo(() => products.filter((p) =>
    (category === "Tümü" || p.category === category) &&
    p.name.toLocaleLowerCase("tr").includes(query.toLocaleLowerCase("tr"))
  ), [products, category, query]);

  const buy = async () => {
    if (!selected) return;
    if (!session) { setToast("Discord oturumun henüz hazır değil."); return; }
    if (balance < selected.price) { setToast("Bu ürün için yeterli coin bakiyen yok."); return; }
    try {
      const res = await fetch(`${api}/api/shop/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
        body: JSON.stringify({ productId: selected.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "purchase");
      setBalance(Number(data.balance ?? balance - selected.price));
      setSelected(null);
      setToast("Sipariş oluşturuldu. Coin bakiyen güncellendi.");
    } catch (error) {
      setToast(error instanceof Error && error.message === "insufficient_balance" ? "Yeterli coin bakiyen yok." : "Sipariş oluşturulamadı.");
    }
  };

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3500); return () => clearTimeout(t); } }, [toast]);

  return <main className="app-shell">
    <div className="ambient ambient-one" /><div className="ambient ambient-two" />
    <header className="topbar">
      <div className="brand"><div className="brand-mark">FR</div><div><strong>FR FAMILY</strong><span>COMMUNITY SHOP</span></div></div>
      <div className="profile">
        {user.avatar?.startsWith("http") ? <img className="avatar" src={user.avatar} alt="Discord avatar" /> : <div className="avatar avatar-fallback">FR</div>}
        <div className="profile-copy"><b>{user.name}</b><small>{user.tag}</small></div>
        <div className="balance"><span>🪙</span><b>{balance.toLocaleString("tr-TR")}</b><small>COIN</small></div>
      </div>
    </header>

    <section className="hero">
      <div className="hero-copy-wrap"><p className="eyebrow">FR FAMILY • MAĞAZA</p><h1>Tarzını <em>yükselt.</em></h1><p className="hero-copy">Coinlerini gerçek Discord hesabına bağlı olarak kullan. Rollerini seç, siparişini oluştur ve bakiyeni anında gör.</p><div className="hero-stats"><span><b>{products.length}</b> ürün</span><span><b>7/24</b> erişim</span><span><b>100%</b> hesap bağlı</span></div></div>
      <div className="hero-showcase"><div className="showcase-card"><span className="showcase-label">BAKİYEN</span><strong>{balance.toLocaleString("tr-TR")}</strong><small>🪙 Coin</small><div className="showcase-line" /></div><div className="hero-orb"><div className="orb-ring">✦</div><span>FR</span></div></div>
    </section>

    <nav className="shop-nav"><div className="tabs">{categories.map((item) => <button className={category === item ? "tab active" : "tab"} onClick={() => setCategory(item)} key={item}>{item === "Tümü" ? "✨ Tümü" : item}</button>)}</div><label className="search">⌕<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ürün ara..." /></label></nav>

    <section className="section-heading"><div><p className="eyebrow">MAĞAZAYI KEŞFET</p><h2>Senin için seçtiklerimiz</h2></div><span className="live-dot">● {loading ? "Bağlanıyor" : "Hesap bağlı"}</span></section>
    {activityError && <div className="activity-status"><span>!</span><div><b>Discord bağlantısı kurulamadı</b><small>{activityError}</small></div></div>}
    <section className="product-grid">{visible.map((p) => <article className={p.featured ? "product-card featured" : "product-card"} key={p.id}><div className="card-top"><ProductIcon icon={p.icon}/>{p.featured && <span className="badge">ÖNE ÇIKAN</span>}</div><p className="product-category">{p.category}</p><h3>{p.name}</h3><p className="product-description">{p.description}</p><div className="card-bottom"><strong>{money(p.price)}</strong><button onClick={() => setSelected(p)}>İncele <span>↗</span></button></div></article>)}</section>
    <footer><span>© 2026 FR FAMILY</span><span>🔒 Siparişler yönetici onaylıdır</span><span>Discord Activity • Gerçek bakiye</span></footer>

    {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}><div className="modal" onClick={(e) => e.stopPropagation()}><button className="close" onClick={() => setSelected(null)}>×</button><ProductIcon icon={selected.icon}/><p className="eyebrow">{selected.category}</p><h2>{selected.name}</h2><p>{selected.description} Sipariş oluşturulduğunda gerçek coin bakiyenden düşülür ve yöneticiye onay için iletilir.</p><div className="modal-price">{money(selected.price)}<small>Mevcut bakiye: {money(balance)}</small></div><button className="primary" disabled={balance < selected.price || !session} onClick={buy}>{!session ? "Discord bağlantısı bekleniyor" : balance < selected.price ? "Yetersiz coin" : "Satın alma talebi oluştur"}<span>→</span></button><button className="secondary" onClick={() => setSelected(null)}>Vazgeç</button></div></div>}
    {toast && <div className="toast">✓ {toast}</div>}
  </main>;
}
