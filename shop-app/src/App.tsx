import { useEffect, useMemo, useState } from "react";
import "./styles.css";

type Product = { id: string; name: string; category: string; price: number; icon: string; description: string; featured?: boolean };
const demoProducts: Product[] = [
  { id: "emperor", name: "FR | EMPEROR", category: "Üst Roller", price: 50000, icon: "👑", description: "Sunucunun en prestijli rolü.", featured: true },
  { id: "king", name: "FR | KING", category: "Üst Roller", price: 40000, icon: "♛", description: "Gücünü ve tarzını göster." },
  { id: "elite", name: "FR | ELİTE", category: "Üst Roller", price: 30000, icon: "💎", description: "Özel topluluğun seçimi." },
  { id: "vip", name: "FR | VİP", category: "Üst Roller", price: 15000, icon: "⚡", description: "VIP ayrıcalıklarla öne çık." },
  { id: "custom", name: "Özel Rol", category: "Özel Rol", price: 25000, icon: "🎨", description: "Sana özel bir rol talep et." },
  { id: "nitro", name: "1 Aylık Discord Nitro", category: "Diğer Ürünler", price: 100000, icon: "🎁", description: "Nitro siparişin manuel olarak teslim edilir." },
];

const money = (n: number) => `${n.toLocaleString("tr-TR")} Coin`;
const api = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

export default function App() {
  const [products, setProducts] = useState<Product[]>(demoProducts);
  const [balance, setBalance] = useState(0);
  const [category, setCategory] = useState("Tümü");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Product | null>(null);
  const [toast, setToast] = useState("");
  const [session, setSession] = useState(() => sessionStorage.getItem("fr_shop_session") || "");
  const [user, setUser] = useState({ name: "Discord Kullanıcısı", tag: "@discord-user", avatar: "🧑‍🚀" });

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const hashSession = hash.get("session");
    if (hashSession) { sessionStorage.setItem("fr_shop_session", hashSession); setSession(hashSession); window.history.replaceState({}, "", window.location.pathname + window.location.search); }
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch(`${api}/api/shop/catalog`, { headers: session ? { Authorization: `Bearer ${session}` } : {} });
        if (response.status === 401) { const auth = await response.json(); window.location.href = auth.loginUrl; return; }
        if (!response.ok) throw new Error("catalog");
        const data = await response.json();
        setProducts(data.products || demoProducts);
        setBalance(Number(data.balance || 0));
        if (data.user) setUser(data.user);
      } catch {
        // Activity API bağlanana kadar tasarım canlı demo verisiyle açılır.
      }
    };
    load();
  }, [session]);

  const categories = ["Tümü", ...Array.from(new Set(products.map((p) => p.category)))];
  const visible = useMemo(() => products.filter((p) =>
    (category === "Tümü" || p.category === category) &&
    p.name.toLocaleLowerCase("tr").includes(query.toLocaleLowerCase("tr"))
  ), [products, category, query]);

  const buy = async () => {
    if (!selected) return;
    if (balance < selected.price && api) {
      setToast("Bu ürün için yeterli coin bakiyen yok.");
      return;
    }
    try {
      if (api) {
        const res = await fetch(`${api}/api/shop/purchase`, {
          method: "POST", headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session}` } : {}) },
          body: JSON.stringify({ productId: selected.id }),
        });
        if (res.status === 401) { const auth = await res.json(); window.location.href = auth.loginUrl; return; }
        if (!res.ok) throw new Error("purchase");
        const data = await res.json();
        setBalance(Number(data.balance ?? balance - selected.price));
      }
      setSelected(null);
      setToast("Siparişin alındı! Yönetici onayından sonra teslim edilecek.");
    } catch {
      setToast("Sipariş oluşturulamadı, lütfen Discord üzerinden tekrar dene.");
    }
  };

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3500); return () => clearTimeout(t); } }, [toast]);

  return <main className="app-shell">
    <div className="ambient ambient-one" /><div className="ambient ambient-two" />
    <header className="topbar">
      <div className="brand"><div className="brand-mark">FR</div><div><strong>FR FAMILY</strong><span>COMMUNITY SHOP</span></div></div>
      <div className="profile"><div className="avatar">{user.avatar}</div><div><b>{user.name}</b><small>{user.tag}</small></div><div className="balance"><span>🪙</span><b>{balance.toLocaleString("tr-TR")}</b><small>COIN</small></div></div>
    </header>
    <section className="hero"><div><p className="eyebrow">FR FAMILY • MAĞAZA</p><h1>Tarzını <em>yükselt.</em></h1><p className="hero-copy">Topluluğun içinde fark yaratacak roller ve özel ürünler burada.</p><div className="hero-stats"><span><b>6</b> seçili ürün</span><span><b>24/7</b> sipariş</span><span><b>100%</b> güvenli</span></div></div><div className="hero-orb"><div className="orb-ring">✦</div><span>FR</span></div></section>
    <nav className="shop-nav"><div className="tabs">{categories.map((item) => <button className={category === item ? "tab active" : "tab"} onClick={() => setCategory(item)} key={item}>{item === "Tümü" ? "✨ Tümü" : item}</button>)}</div><label className="search">⌕<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ürün ara..." /></label></nav>
    <section className="section-heading"><div><p className="eyebrow">MAĞAZAYI KEŞFET</p><h2>Senin için seçtiklerimiz</h2></div><span className="live-dot">● Sistem aktif</span></section>
    <section className="product-grid">{visible.map((p) => <article className={p.featured ? "product-card featured" : "product-card"} key={p.id}><div className="card-top"><span className="product-icon">{p.icon}</span>{p.featured && <span className="badge">ÖNE ÇIKAN</span>}</div><p className="product-category">{p.category}</p><h3>{p.name}</h3><p className="product-description">{p.description}</p><div className="card-bottom"><strong>{money(p.price)}</strong><button onClick={() => setSelected(p)}>İncele <span>↗</span></button></div></article>)}</section>
    <footer><span>© 2026 FR FAMILY</span><span>🔒 Siparişler yönetici onaylıdır</span><span>Discord sunucunda <b>/shop</b> ile açılır</span></footer>
    {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}><div className="modal" onClick={(e) => e.stopPropagation()}><button className="close" onClick={() => setSelected(null)}>×</button><div className="modal-icon">{selected.icon}</div><p className="eyebrow">{selected.category}</p><h2>{selected.name}</h2><p>{selected.description} Sipariş oluşturulduğunda coin bakiyen düşer ve yöneticiye onay için iletilir.</p><div className="modal-price">{money(selected.price)}<small>Mevcut bakiye: {money(balance)}</small></div><button className="primary" onClick={buy}>Satın alma talebi oluştur <span>→</span></button><button className="secondary" onClick={() => setSelected(null)}>Vazgeç</button></div></div>}
    {toast && <div className="toast">✓ {toast}</div>}
  </main>;
}
