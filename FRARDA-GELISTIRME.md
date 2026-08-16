# FrArda Geliştirme Notları

- Otomatik `/frbosszzz` sistemi kaldırıldı.
- Takviye/boost bildirim sistemi kaldırıldı.
- `/sunucu-bilgi` slash komutu eklendi.
- `/kullanici-bilgi` slash komutu eklendi; kullanıcı seçilmezse komutu kullanan kişiyi gösterir.
- Bilgi komutları normal üyeler tarafından kullanılabilir; moderasyon komutları yetki kontrolünü korur.
- Sunucu bilgisi: sahip, üye sayısı, kanal dağılımı, rol sayısı, doğrulama seviyesi, sunucu özellikleri ve oluşturulma tarihi.
- Kullanıcı bilgisi: kullanıcı adı, görünen ad, sunucu takma adı, bot durumu, hesap oluşturulma, sunucuya katılma, roller ve timeout durumu.
- Render/GitHub yapılandırması korunmuştur.

Not: Bu ortamda internet erişimi olmadığı için pnpm bağımlılık kurulumu ve tam TypeScript typecheck çalıştırılamadı.
- Groq API korunuyor; AI sohbet sistemi eklendi.
- FrArda artık yalnızca @etiketlendiğinde veya FrArda'nın mesajına yanıt verildiğinde Groq ile sohbet eder.
- AI yanıt verirken sunucunun temel bilgilerini ve adı kural/rules/kurallar/bilgi/duyuru olan kanallardaki son mesajları bağlam olarak okur.
- Kurallarda bulunmayan bilgileri uydurmaması için sistem talimatı eklendi.



## V7/V8 — PostgreSQL tamamen kaldırıldı
- PostgreSQL, Drizzle ve `@workspace/db` bağımlılığı kaldırıldı.
- `DATABASE_URL` artık gerekli değil.
- Uygulama açılışında veritabanı başlatma çağrısı yok.
- Render build komutu lockfile ile paket manifestosu değiştiğinde kurulumu güncelleyebilir.
- Groq API, AI sohbeti, sunucu/kullanıcı bilgi komutları ve moderasyon/itiraz akışı korunmuştur.
