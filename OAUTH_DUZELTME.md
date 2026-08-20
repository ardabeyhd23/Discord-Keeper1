# OAuth düzeltmesi

Bu sürümde OAuth `state` artık sadece RAM'de tutulmaz. Render'ın uykuya geçmesi/yeniden başlaması OAuth dönüşünde `OAuth oturumu geçersiz veya süresi dolmuş` hatasına yol açmasın diye state, Client Secret ile imzalanmış şekilde taşınır.

Discord Developer Portal → OAuth2 → Redirects bölümünde yalnızca:

`https://discord-keeper1.onrender.com/api/shop/auth/callback`

bulunsun.

Test için OAuth2 URL oluşturucudan elle link üretmeyin. Tarayıcıdan doğrudan:

`https://discord-keeper1.onrender.com/api/shop/auth/discord`

adresini açın. Sunucu state'i kendisi üretir ve Discord'a yönlendirir.

Render Environment:
- DISCORD_CLIENT_ID = Application ID
- DISCORD_CLIENT_SECRET = Client Secret
- FR_SHOP_OAUTH_REDIRECT_URI = https://discord-keeper1.onrender.com/api/shop/auth/callback
- FR_SHOP_ACTIVITY_URL = https://discord-keeper1.onrender.com
- FR_SHOP_ACTIVITY_ENABLED = false
- VITE_DISCORD_CLIENT_ID = Application ID
