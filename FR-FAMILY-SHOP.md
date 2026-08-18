# FR Family Shop

Eklenen sistemler:

- `/shop` — yalnızca Sunucuyu Yönet/Yönetici yetkisi olanlar kullanabilir; `#mağaza` kanalına herkesin görebildiği mağaza giriş mesajını gönderir. Yönetici düz metin olarak `shop` yazarsa da aynı işlem yapılır. Kullanıcı **🛒 Mağazayı Aç** butonuna bastığında kişisel/ephemeral GUI açılır; bakiye, ürünler ve sipariş ekranları yalnızca o kullanıcıya görünür. `/shop` veya `shop` kullanıldığında kampanya zamanı geldiyse `#kampanyalar` kanalına otomatik kampanya mesajı da gönderilir.
- `coin` — kullanıcı kendi coin bakiyesini görür; mesaj ve cevap kısa süre sonra silinir.
- `/coin-ekle kullanici miktar` — yetkili kullanıcıya coin ekler.
- Üst Roller — Discord'daki gerçek rol sırası korunarak yalnızca satış için tanımlanmış FR rollerini listeler; teknik roller (ör. `FR | BOT`) otomatik olarak gizlenir. Rolün Discord'da özel rol ikonu varsa kişisel rol ekranında küçük görsel olarak gösterilir. Bot/managed roller ve `İSTEK ÖNERİ & ŞİKAYET` gibi FR olmayan işlevsel roller listeye girmez. Bot rolü otomatik vermez; satın alma sipariş olarak yöneticiye gönderilir.
- Satışa açık roller: `FR | EMPEROR` (50.000), `FR | KING` (40.000), `FR | ROBUX MANYAĞI` (45.000), `FR | AYYILDIZ` (20.000), `FR | ELITE` (30.000), `FR | BAŞ YÖNETİCİ` (15.000), `FR | KIDEMLİ AİLE YÖNETİCİSİ` (12.500), `FR | BARON` (10.000), `FR | VIP` (5.000) Coin. Kampanyada %50 indirim uygulanır.
- Özel Rol — coin düşer, sipariş yöneticiye DM olarak gider; rol bot tarafından oluşturulmaz/verilmez.
- Coin Satın Al — FRArda iletişim sayfasına yönlendirir. Join seçeneği mağazadan kaldırılmıştır.
- Diğer Ürünler — şimdilik **1 Aylık Discord Nitro: 100.000 coin**. Nitro teslimatı bot tarafından otomatik yapılmaz; sipariş FRArda'ya gönderilir.
- `#sipariş-aktivasyonu` — siparişin kullanıcı adı, kullanıcı ID'si, ürün, tutar ve durumunu gösterir.
- Yöneticiye DM ile gelen her siparişte **✅ Sipariş Tamamlandı** butonu bulunur. Butona basıldığında sipariş tamamlanır ve `#sipariş-aktivasyonu` kanalına otomatik tamamlandı bildirimi gönderilir.
- `/siparis-tamamla siparis:<ID>` — alternatif olarak yetkili siparişi tamamlar ve aktivasyon kanalına tamamlandı mesajı gönderir.
- `#kampanyalar` — ilk başlatmada ve her 5 günde bir otomatik kampanya mesajı gönderir. Kampanya döneminde mağazadaki ürünlere %50 indirim uygulanır; indirimli fiyatlar mağazada otomatik gösterilir.
- Rol fiyatları için isteğe bağlı `SHOP_ROLE_PRICES_JSON` kullanılabilir. Örnek: `{ "ROL_ID": 2500 }`
- Kampanya görseli için isteğe bağlı `SHOP_CAMPAIGN_IMAGE_URL` kullanılabilir.

Siparişler ve coinler `data/fr-family-shop.json` içinde tutulur. Render'da kalıcı disk kullanılmıyorsa yeniden deploy/restart sonrasında bu dosya kaybolabilir; kalıcı üretim kullanımı için PostgreSQL katmanına geçirilmesi önerilir.


### GUI v6 — kişisel mağaza arayüzü
- Mağaza arayüzü görsel banner + zengin embed kartlarıyla yenilendi.
- Ortak `#mağaza` mesajı artık kullanıcı bakiyesi göstermez; **🛒 Mağazayı Aç** ile kişiye özel ephemeral mağaza açılır. Böylece bir kullanıcının coin bakiyesi veya GUI değişikliği diğer kullanıcılara yansımaz.
- Kategori, rol, onay ve sipariş ekranlarında emoji kullanımı ve kişisel bakiye görünümü iyileştirildi.
- Satışa açık rol listesi gerçek Discord rol sırasını korur ve yalnızca tanımlı satış rollerini gösterir.
- Rol, özel rol ve Nitro alımlarında önce **Satın Alma Onayı** ekranı açılır; kullanıcı onaylamadan coin düşmez.
- Mağaza bannerı Render üzerinde `/shop-assets/fr-family-shop.png` olarak servis edilir; `SHOP_BANNER_URL` ile değiştirilebilir.
