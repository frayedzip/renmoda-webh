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

    // The subscription is created from just the plan — no customer yet. The
    // member enters their details ON Razorpay's hosted page, so identity is
    // resolved later from the email Razorpay collected (see membership.js). Only
    // the plan's tag is stamped into notes; Razorpay echoes notes back on every
    // webhook, so the handler knows which tag to apply without a catalog lookup.
    async createSubscription({ planId, planKey, planTag }) {
      const subscription = await client.subscriptions.create({
        plan_id: planId,
        total_count: config.razorpay.totalCount,
        customer_notify: 1,
        notes: {
          plan: planKey,
          plan_tag: planTag,
        },
      });
      return {
        subscriptionId: subscription.id,
        shortUrl: subscription.short_url,
        status: subscription.status,
      };
    },

    // Identity fallback for events that carry no payment entity (activated,
    // halted, cancelled): the subscription entity always has customer_id, and
    // the Razorpay customer holds the email the member entered at checkout.
    async fetchCustomerEmail(customerId) {
      if (!customerId) return null;
      const customer = await client.customers.fetch(customerId);
      return customer?.email ?? null;
    },
  };
}
