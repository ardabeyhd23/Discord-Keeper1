# FrArda V10

- Moderasyon olayında gerçek mesaj yazarının Discord user ID'si `message.author.id` üzerinden kaydedilir.
- İtiraz bildirimi artık kullanıcı görünen adı, `@username` ve Discord ID'sini birlikte gösterir.
- Moderasyon DM'inde de kullanıcı adı ve ID gösterilir.
- Yerel küfür/argo filtresi kelime sınırları kullanır; `mal` gibi kısa kelimelerin başka kelimelerin içinde geçmesi yanlış pozitif oluşturmaz.
- Groq moderasyon kararı tek başına yeterli değildir: Groq'un işaretlediği kelime/ifade mesaj içinde doğrulanır. Doğrulanamazsa mesaj temiz kabul edilir.
- Yönetici/`Yönetici` veya `Sunucuyu Yönet` yetkisine sahip kullanıcıların normal mesajları otomatik moderasyona sokulmaz.
- AI sohbeti yalnızca FrArda etiketlendiğinde veya FrArda'nın mesajına yanıt verildiğinde çalışır.
- Otomatik sunucuya katılma/hoş geldin mesajları yoktur.
