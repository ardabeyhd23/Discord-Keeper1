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


## V5 — PostgreSQL
- Render PostgreSQL için `DATABASE_URL` kullanılıyor.
- `guilds` tablosu sunucu adı, sahibi, üye sayısı ve FrArda'nın sunucu/kurallar bilgisini kalıcı tutuyor.
- `user_profiles` tablosu sunucudaki kullanıcıların temel profil/son görülme bilgisini kalıcı tutuyor.
- Uygulama açılışında tablolar otomatik oluşturuluyor.
- Groq API ve etiket/yanıt ile AI sohbet sistemi korunuyor.

Render'da bot servisinin Environment Variables kısmına `DATABASE_URL` eklenmeli. Render PostgreSQL oluşturulduğunda Internal Database URL değeri kullanılabilir.


## V6 — Geliştirilmiş moderasyon ve itiraz
- Küfür/argo algılama; farklı yazım ve bazı karakter değiştirmelerini daha iyi yakalar.
- Moderasyon vakaları PostgreSQL'e kalıcı kaydedilir.
- İtiraz butonu artık üyeden kısa bir itiraz gerekçesi alır.
- İtiraz doğrudan FrArda sahibinin DM'ine gönderilir; `FRARDA_OWNER_ID` varsa önceliklidir, yoksa sunucu sahibi kullanılır.
- Sahip 5 dakika içinde karar vermezse kullanıcıya otomatik kural sınaması gönderilir.
- İtiraz kabul/red ve sınama sonucu veritabanına işlenir.
