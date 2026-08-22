# AI yapılandırması

- Botun sohbeti ve moderasyonu yalnızca Groq üzerinden çalışır; OpenRouter fallback'i kaldırılmıştır.
- Metin sohbeti için `GROQ_MODEL` kullanılır.
- Görsel moderasyonu için `GROQ_VISION_MODEL` kullanılır. Varsayılan:
  `meta-llama/llama-4-scout-17b-16e-instruct`
- Groq API/model yanıt vermezse bot güvenli tarafta kalır ve görseli otomatik
  silmez; bağlantı ve model adı loglarda görünür.
