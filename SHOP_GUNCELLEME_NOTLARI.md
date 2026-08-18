# FR Family Shop güncellemesi

- Satın alınabilir üst roller artık yalnızca:
  - FR | EMPEROR — 50.000 Coin
  - FR | KING — 40.000 Coin
  - FR | ELİTE — 30.000 Coin
  - FR | VİP — 15.000 Coin
- `/shop` artık herkese açık mağaza giriş mesajını gönderir; bakiye ve alışveriş ekranı `🛍️ Mağaza Aç` butonuna basan kişiye özel açılır.
- İlk mağaza mesajında `Kişisel menü` ifadesi kaldırıldı.
- Kampanya kanalı için verilen kanal ID'si `1538967777476616222` öncelikli kullanılır; kanal adı bulunamazsa isimle arama yedek olarak devam eder.
- `/kampanya` yalnızca yöneticiler tarafından kullanılabilir, rastgele indirim başlatır ve 2 gün sürer.
- Kampanya bitince fiyatlar normale döner ve kampanya kanalına bitiş mesajı gönderilir.
- Kampanya mesajında kampanyayı başlatan kişinin adı belirtilmez.

## v11 - Ürün/Rol Ekleme
- `FR | ROBUX MANYAĞI` varsayılan üst roller listesine geri eklendi.
- `FR | AYYILDIZ` da varsayılan üst roller listesinde.
- Yönetici komutu: `/urun-ekle rol:<rol> fiyat:<coin>`
  - Seçilen Discord rolünü mağazanın **Üst Roller** kategorisine ekler.
  - Fiyatı sunucuya kalıcı olarak kaydeder.
- Yönetici komutu: `/urun-kaldir rol:<rol>`
  - Yönetici tarafından sonradan eklenen rolü mağazadan kaldırır.
- Eklenen roller kampanya indirimlerine otomatik olarak dahil edilir.
- Mağaza rol sırası Discord'daki rol pozisyonuna göre gösterilmeye devam eder.
\n## v14.1 - Coin kalıcılık ve GUI yenileme düzeltmesi
- `/coin-ekle` ile verilen coin güvenli kayıt kuyruğuyla diske yazılır; eşzamanlı işlemler birbirini ezmez.
- Shop state yükleme işlemi yarış durumuna karşı kilitlendi; ilk açılışta mağazanın yanlışlıkla 0 bakiye göstermesi engellendi.
- `/coin` artık normal kullanıcılar tarafından da kullanılabilir.
- Coin eklenen kullanıcının açık kişisel Shop GUI'si varsa bakiye anında yenilenir.
- Render için `SHOP_DATA_DIR=/var/data` ve 1 GB kalıcı disk tanımı eklendi; restart/deploy sonrası coinler korunur.
