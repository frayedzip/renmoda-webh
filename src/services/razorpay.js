import crypto from 'node:crypto';
import Razorpay from 'razorpay';

export function createRazorpayService(config) {
  const client = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });

  return {
    // The signature is an HMAC-SHA256 over the EXACT BYTES Razorpay sent.
    // That's why the caller must pass the raw body Buffer captured before any
    // JSON parsing — re-serializing a parsed body changes key order and
    // whitespace and the HMAC never matches.
    verifyWebhookSignature(rawBody, signature) {
      if (!rawBody || !signature) return false;
      const expected = crypto
        .createHmac('sha256', config.razorpay.webhookSecret)
        .update(rawBody)
        .digest('hex');
      const expectedBuf = Buffer.from(expected, 'utf8');
      const actualBuf = Buffer.from(signature, 'utf8');
      // timingSafeEqual throws on unequal lengths, so guard first. Length is
      // not secret (always 64 hex chars for a valid signature).
      if (expectedBuf.length !== actualBuf.length) return false;
      return crypto.timingSafeEqual(expectedBuf, actualBuf);
    },

    // Each member gets their OWN subscription with their Shopify customer ID
    // stamped into notes. Razorpay echoes notes back on every webhook, which is
    // the entire identity-mapping strategy — no mapping table to drift.
    async createSubscription({ shopifyCustomerId, email }) {
      const subscription = await client.subscriptions.create({
        plan_id: config.razorpay.planId,
        total_count: config.razorpay.totalCount,
        customer_notify: 1,
        notes: {
          shopify_customer_id: shopifyCustomerId,
          ...(email ? { email } : {}),
        },
      });
      return {
        subscriptionId: subscription.id,
        shortUrl: subscription.short_url,
        status: subscription.status,
      };
    },
  };
}
