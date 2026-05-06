# obnofi-crawler

Standalone crawling microservice. Receives a URL, fetches the page (including JS-rendered SPAs via headless Chromium), and returns clean Markdown.

## Stack

- Node.js (ESM)
- Fastify v4
- Playwright (Chromium, headless)
- Turndown + turndown-plugin-gfm
- @fastify/cors

## Setup

```bash
npm install
npm run install:browser   # downloads Chromium for Playwright
cp .env.example .env
```

## Run

```bash
npm run dev      # node --watch with pino-pretty logs
npm start        # production mode
```

Listens on `HOST:PORT` (default `0.0.0.0:3100`).

## API

### `POST /crawl`

Request body:

```json
{
  "url": "https://example.com",
  "spa": false,
  "timeout": 15000,
  "waitFor": "domcontentloaded"
}
```

| Field   | Type    | Default            | Notes                                              |
| ------- | ------- | ------------------ | -------------------------------------------------- |
| url     | string  | required           | Must be a valid URI                                |
| spa     | boolean | `false`            | If true, also waits for `networkidle`              |
| timeout | integer | `15000`            | Navigation timeout in ms                           |
| waitFor | string  | `domcontentloaded` | One of `domcontentloaded`, `load`, `networkidle`   |

Success response:

```json
{
  "title": "Page Title",
  "url": "https://example.com",
  "markdown": "# Page Title\n\n...",
  "crawledAt": "2026-05-06T10:00:00.000Z",
  "wordCount": 342
}
```

Error response:

```json
{
  "error": "CrawlError",
  "message": "...",
  "url": "https://example.com"
}
```

Status codes:

- `408` — navigation/operation timeout
- `502` — network/DNS error
- `500` — any other crawl failure

### `GET /health`

```json
{ "status": "ok", "service": "obnofi-crawler" }
```

## Environment

| Variable          | Default     | Purpose                                          |
| ----------------- | ----------- | ------------------------------------------------ |
| `PORT`            | `3100`      | HTTP port                                        |
| `HOST`            | `0.0.0.0`   | Bind address                                     |
| `LOG_LEVEL`       | `info`      | Pino log level                                   |
| `ALLOWED_ORIGIN`  | `*`         | CORS origin (set to a real domain in production) |
| `MAX_CONCURRENCY` | `4`         | Max concurrent crawls; excess requests queue     |

## Behavior notes

- Chromium runs as a single shared process; each request gets its own `BrowserContext` and is closed in a `finally` block. The browser is closed on `SIGINT`/`SIGTERM`.
- Concurrent crawls are gated by a semaphore (`MAX_CONCURRENCY`); overflow waits in a queue.
- Image and font requests are aborted at the route layer for speed.
- SSRF guard: only `http`/`https` URLs are accepted; hostnames are resolved via DNS and blocked if any address falls in loopback / private / link-local / CGNAT / multicast / reserved ranges (IPv4 and IPv6, including `::ffff:` mapped addresses). Returns `400` when blocked.
- Content extraction order: `main` → `article` → `[role="main"]` → `.content` → `.post` → `#content` → `body`. Selectors with fewer than 200 characters of text are skipped so empty `<main>` shells don't shadow real content.
- Tags stripped before Markdown conversion: `script`, `style`, `noscript`, `iframe`, `nav`, `footer`, `header`, `aside`, `svg`.
- Markdown post-processing collapses 3+ blank lines, removes empty list items, nested image links, and base64 images.
- `networkidle` is only awaited once: when `spa: true` and `waitFor !== 'networkidle'`.
- Persistence is the caller's responsibility — this service returns Markdown, never writes files.
# obnofi-crawler
