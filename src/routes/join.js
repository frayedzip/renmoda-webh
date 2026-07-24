import { Router } from 'express';
import { normalizeCustomerGid } from '../services/shopify.js';

// Join MUST go through this backend: each member needs their OWN Razorpay
// subscription with their Shopify customer id in notes. A single shared
// payment link would leave the webhook with no way to tell whose wallet to
// credit.

export function createJoinRouter({ config, razorpay, shopify, log }) {
  const router = Router();

  async function resolveCustomerGid(shopifyCustomerId, email) {
    if (shopifyCustomerId) {
      return normalizeCustomerGid(shopifyCustomerId);
    }
    if (email) {
      const gid = await shopify.findCustomerByEmail(email);
      if (!gid) {
        const err = new Error(`No Shopify customer found for email ${email}`);
        err.statusCode = 404;
        throw err;
      }
      return gid;
    }
    const err = new Error('shopifyCustomerId or email is required');
    err.statusCode = 400;
    throw err;
  }

  router.post('/', async (req, res) => {
    const { shopifyCustomerId, email } = req.body ?? {};
    try {
      const customerGid = await resolveCustomerGid(shopifyCustomerId, email);
      const { subscriptionId, shortUrl } = await razorpay.createSubscription({
        shopifyCustomerId: customerGid,
        email,
      });
      log.info('subscription created', { subscriptionId, customerGid });
      res.status(200).json({ subscriptionId, shortUrl });
    } catch (err) {
      log.error('join failed', { error: err.message, shopifyCustomerId, email });
      res.status(err.statusCode ?? 502).json({ error: err.message });
    }
  });

  // Plain-link variant so the storefront button needs zero JS:
  // <a href="https://.../join/redirect?customerId={{ customer.id }}">Join</a>
  router.get('/redirect', async (req, res) => {
    const { customerId, email } = req.query;
    try {
      const customerGid = await resolveCustomerGid(customerId, email);
      const { subscriptionId, shortUrl } = await razorpay.createSubscription({
        shopifyCustomerId: customerGid,
        email,
      });
      log.info('subscription created (redirect flow)', { subscriptionId, customerGid });
      res.redirect(302, shortUrl);
    } catch (err) {
      log.error('join redirect failed', { error: err.message, customerId, email });
      res.redirect(302, config.join.failureUrl);
    }
  });

  return router;
}
