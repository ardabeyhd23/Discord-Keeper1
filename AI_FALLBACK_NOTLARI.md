# V17 AI Fallback

- Groq birincil AI olarak kalır.
- Groq hata/limit/boş cevap verdiğinde OpenRouter otomatik denenir.
- Ücretsiz yönlendirici model: `openrouter/free`.
- Ortam değişkeni: `OPENROUTER_API_KEY`.
- İsteğe bağlı: `OPENROUTER_MODEL`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`.
- OpenRouter ücretsiz modellerinde hesap başına güncel oran limitleri vardır; bu nedenle bu katman sınırsız değildir.
