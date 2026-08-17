import crypto from 'node:crypto';
import { Router } from 'express';

export function createWebhookRouter({ store, razorpay, membership, log, onEventProcessed }) {
  const router = Router();

  // Post-ack Shopify work still in flight, so graceful shutdown can drain it
  // instead of dropping half-applied credit resets.
  const inFlight = new Set();

  router.post('/razorpay', (req, res) => {
    // Verify against req.rawBody (the exact bytes Razorpay signed), never the
    // parsed+re-serialized body — see server.js.
    const signature = req.get('x-razorpay-signature');
    if (!razorpay.verifyWebhookSignature(req.rawBody, signature)) {
      log.warn('webhook rejected: bad signature', {
        hasSignature: Boolean(signature),
        ip: req.ip,
      });
      return res.status(401).json({ error: 'invalid signature' });
    }

    const body = req.body ?? {};
    const eventType = body.event ?? 'unknown';
    // Razorpay sends a unique id per event; fall back to a body hash so a
    // redelivery (identical bytes) still dedupes if the header ever vanishes.
    const eventId =
      req.get('x-razorpay-event-id') ||
      crypto.createHash('sha256').update(req.rawBody).digest('hex');

    // Log arrival before any processing: this is what distinguishes "Razorpay
    // never sent the event" from "we got it and it did nothing" — the first
    // question to answer when a cancellation appears to have been ignored.
    log.info('webhook received', {
      eventId,
      eventType,
      subscriptionId: body?.payload?.subscription?.entity?.id ?? null,
      subscriptionStatus: body?.payload?.subscription?.entity?.status ?? null,
    });

    // Claim BEFORE acking so a concurrent duplicate delivery can't slip in
    // between the response and the insert.
    if (!store.claimEvent(eventId, eventType)) {
      log.info('duplicate webhook delivery ignored', { eventId, eventType });
      return res.status(200).json({ status: 'duplicate' });
    }

    // Ack now, then do the slow Shopify work. Razorpay times out slow
    // responses and retries — which would look like duplicates forever.
    // Unhandled event types also get this 200: returning 4xx would put them
    // in a permanent retry loop.
    res.status(200).json({ status: 'accepted' });

    const work = membership
      .handleEvent(eventType, body, eventId)
      .then(() => {
        onEventProcessed?.(null, eventId);
      })
      .catch((err) => {
        // We already 200'd, so Razorpay will NEVER redeliver this event.
        // Nothing automated will retry it — this log line is the only signal
        // a human gets that a paid member didn't receive credit.
        log.error('EVENT PROCESSING FAILED AFTER ACK — needs manual attention', {
          needs_attention: true,
          eventId,
          eventType,
          error: err.message,
          stack: err.stack,
        });
        onEventProcessed?.(err, eventId);
      });

    inFlight.add(work);
    work.finally(() => inFlight.delete(work));
  });

  router.drain = () => Promise.allSettled([...inFlight]);
  return router;
}
