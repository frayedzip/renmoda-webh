import { pathToFileURL } from 'node:url';
import express from 'express';
import { loadConfig } from './lib/config.js';
import { createLogger, openLogSink } from './lib/log.js';
import { createStore } from './db/store.js';
import { createRazorpayService } from './services/razorpay.js';
import { createShopifyService } from './services/shopify.js';
import { createMembershipService } from './services/membership.js';
import { createWebhookRouter } from './routes/webhook.js';
import { createJoinRouter } from './routes/join.js';
import { createOAuthRouter } from './routes/oauth.js';

export function createApp(deps) {
  const app = express();
  app.disable('x-powered-by');

  // Capture the raw request bytes BEFORE JSON parsing. Razorpay's
  // X-Razorpay-Signature is an HMAC over the exact bytes it sent; parsing and
  // re-serializing changes key order/whitespace and the HMAC never matches.
  // This is the #1 cause of "mysteriously failing" Razorpay webhooks.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  const webhookRouter = createWebhookRouter(deps);
  app.use('/webhooks', webhookRouter);
  app.use('/join', createJoinRouter(deps));
  app.use('/oauth', createOAuthRouter(deps));

  // JSON error handler (covers malformed-JSON bodies from express.json too).
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    deps.log.error('request error', { error: err.message });
    res.status(err.status ?? 500).json({ error: err.message });
  });

  app.drainWebhooks = webhookRouter.drain;
  return app;
}

function main() {
  const config = loadConfig();
  const logSink = openLogSink(config.log);
  const log = createLogger({ service: 'renmoda-membership' }, { sink: logSink });

  const store = createStore(config.dbPath);
  const shopify = createShopifyService(config, { log, store });
  const razorpay = createRazorpayService(config);
  const membership = createMembershipService({ config, store, shopify, razorpay, log });

  const app = createApp({ config, store, shopify, razorpay, membership, log });
  const server = app.listen(config.port, () => {
    log.info('listening', {
      port: config.port,
      shop: config.shopify.shop,
      plans: Object.keys(config.plans),
      logFile: logSink?.path ?? null,
    });
  });

  // Verify Shopify auth at boot. Non-fatal on failure: a transient Shopify
  // outage shouldn't stop the service from starting and self-healing (the
  // webhook path refreshes the token on demand). Wrong client credentials
  // still get flagged loudly here rather than silently at the first charge.
  shopify
    .warmUpToken()
    .then(() => log.info('shopify auth ready', { source: shopify.tokenSource() }))
    .catch((err) =>
      log.error('shopify auth check FAILED at boot — will retry on first Admin call', {
        needs_attention: true,
        source: shopify.tokenSource(),
        error: err.message,
      })
    );

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    // Hard deadline: don't hang forever on a stuck Shopify call.
    const force = setTimeout(() => {
      log.error('forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
    force.unref();

    server.close();
    // Finish post-ack credit work before closing the DB — dropping it
    // mid-flight strands a paid member without credit.
    await app.drainWebhooks();
    store.close();
    log.info('shutdown complete');
    logSink?.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
