import Fastify from 'fastify';
import cors from '@fastify/cors';
import { crawl, closeBrowser, prewarm } from './crawler.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;
const HOST = process.env.HOST || '0.0.0.0';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const isDev = process.env.NODE_ENV !== 'production';

const fastify = Fastify({
  logger: {
    level: LOG_LEVEL,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
          },
        }
      : {}),
  },
});

await fastify.register(cors, { origin: ALLOWED_ORIGIN });

const crawlSchema = {
  body: {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', format: 'uri' },
      spa: { type: 'boolean', default: false },
      timeout: { type: 'integer', minimum: 1, default: 15000 },
      waitFor: {
        type: 'string',
        enum: ['domcontentloaded', 'load', 'networkidle'],
        default: 'domcontentloaded',
      },
    },
  },
};

function classifyError(err) {
  const code = err?.code;
  if (
    code === 'INVALID_URL' ||
    code === 'PROTOCOL_NOT_ALLOWED' ||
    code === 'BLOCKED_ADDRESS'
  ) {
    return 400;
  }
  const name = err?.name || '';
  const message = err?.message || '';
  if (name === 'TimeoutError' || /timeout/i.test(message)) {
    return 408;
  }
  if (
    /net::|ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo/i.test(
      message,
    )
  ) {
    return 502;
  }
  return 500;
}

fastify.post('/crawl', { schema: crawlSchema }, async (req, reply) => {
  const { url, spa, timeout, waitFor } = req.body;
  try {
    const result = await crawl(url, { spa, timeout, waitFor });
    process.stdout.write(
      `\n===== crawl body [${url}] (title="${result.title}", words=${result.wordCount}) =====\n` +
        result.markdown +
        `\n===== end =====\n\n`,
    );
    return result;
  } catch (err) {
    req.log.error({ err, url }, 'crawl failed');
    const statusCode = classifyError(err);
    return reply.status(statusCode).send({
      error: 'CrawlError',
      message: err?.message || 'Unknown crawl error',
      url,
    });
  }
});

fastify.get('/health', async () => ({
  status: 'ok',
  service: 'obnofi-crawler',
}));

fastify.addHook('onClose', async () => {
  await closeBrowser();
});

const shutdown = async (signal) => {
  fastify.log.info({ signal }, 'shutdown signal received');
  try {
    await fastify.close();
    process.exit(0);
  } catch (err) {
    fastify.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await fastify.listen({ port: PORT, host: HOST });
  prewarm()
    .then(() => fastify.log.info('browser pre-warmed'))
    .catch((err) => fastify.log.warn({ err }, 'pre-warm failed'));
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
