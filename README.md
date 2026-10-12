# 🎬 YT Scraper API

API simples de **scraping do YouTube** — sem precisar de chave da YouTube Data API.
Puxa **busca, vídeos longos, shorts, transcrição e outliers**, pronta para deploy no **Render**.

Stack: Node.js + Express + `youtubei.js` (InnerTube, API interna do YouTube).

---

## 🚀 Rodando local

```bash
npm install
npm start
# ou dev com reload:
npm run dev
```

API em `http://localhost:3000`.

## ☁️ Deploy no Render (grátis)

**Opção 1 — Blueprint (mais fácil):**

1. Suba este projeto para um repositório no GitHub.
2. No [Render Dashboard](https://dashboard.render.com) → **New → Blueprint** → selecione o repo.
3. O arquivo `render.yaml` já configura tudo (`npm install` + `npm start`).
4. Aguarde o deploy e use a URL `https://seu-app.onrender.com`.

**Opção 2 — Web Service manual:**

1. Render → **New → Web Service** → conecte o repo.
2. Configurações:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
3. Variáveis de ambiente (opcional):
   - `YT_LANG=pt`, `YT_LOCATION=BR`, `CACHE_TTL_SECONDS=300`

> Nota: no plano Free o Render "dorme" após inatividade (~50s p/ acordar na 1ª chamada).

---

## 📡 Endpoints

| Método | Rota                                                                        | Descrição                                                    |
| ------ | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/health`                                                                   | Status                                                       |
| GET    | `/api/search?q=&limit=&type=`                                               | Busca vídeos. `type=all\|video\|shorts`                      |
| GET    | `/api/video/:id`                                                            | Detalhes (views, likes, duração, canal). Aceita ID ou URL    |
| GET    | `/api/video/:id/transcript?lang=pt&format=json\|text\|srt`                  | Transcrição                                                  |
| GET    | `/api/channel/:ref/videos?limit=&sort=new\|popular&filter=all\|short\|long` | Últimos vídeos do canal (`:ref` = `@handle`, `UC...` ou URL) |
| GET    | `/api/channel/:ref/shorts?limit=`                                           | Só shorts do canal                                           |
| POST   | `/api/bulk/videos`                                                          | Detalhes em lote `{ "ids": ["id1","id2"] }` (máx 20)         |
| GET    | `/api/outliers?channel=&limit=&threshold=&minViews=&filter=`                | **Outliers do canal** (score = views / mediana)              |
| GET    | `/api/search-outliers?q=&limit=&threshold=`                                 | **Outliers de um nicho/termo**                               |

### Exemplos

```bash
# Busca
curl "http://localhost:3000/api/search?q=inteligencia%20artificial&limit=10"

# Detalhes (aceita URL também)
curl "http://localhost:3000/api/video/dQw4w9WgXcQ"

# Transcrição como texto
curl "http://localhost:3000/api/video/dQw4w9WgXcQ/transcript?lang=pt&format=text"

# Vídeos de um canal
curl "http://localhost:3000/api/channel/@MrBeast/videos?limit=30&sort=popular&filter=all"

# Shorts
curl "http://localhost:3000/api/channel/@MrBeast/shorts?limit=20"

# Outliers: vídeos que performaram 2x acima da mediana do canal
curl "http://localhost:3000/api/outliers?channel=@MrBeast&limit=30&threshold=2&minViews=5000"

# Só outliers em formato longo
curl "http://localhost:3000/api/outliers?channel=@MrBeast&limit=30&threshold=2&filter=long"

# Outliers de um nicho (acha vídeos que estouraram para o termo)
curl "http://localhost:3000/api/search-outliers?q=finan%C3%A7as&limit=20&threshold=2"
```

### O que é "outlier"?

`outlier_score = views_do_video / mediana_de_views`

- `score >= threshold` (padrão `2`) → é outlier (performou 2x acima da mediana).
- Use `threshold=3` ou `5` para ser mais rigoroso.
- `minViews` filtra vídeos pequenos. `filter=short|long` separa formato.

Resposta inclui `stats { median_views, mean_views }`, lista `outliers` e `all_videos_ranked`.

---

## ⚙️ Config (.env)

```bash
cp .env.example .env
# PORT=3000
# YT_LANG=pt
# YT_LOCATION=BR
# CACHE_TTL_SECONDS=300
```

- Rate limit padrão: 60 req/min.
- Cache em memória com header `X-Cache: HIT/MISS`.

## ⚠️ Avisos

- Projeto educacional. Respeite os [Termos do YouTube](https://www.youtube.com/t/terms).
- Scraping pode sofrer rate-limit/bloqueio temporário se abusar. O cache + rate limit ajudam.
- Transcrição só existe se o vídeo tiver legendas (manuais ou automáticas).
