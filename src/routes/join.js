import { Router } from 'express';

// Join takes ONLY a plan. The member has no Shopify account yet — they enter
// their details on Razorpay's hosted page, and identity is resolved from that
// email when the webhook fires (see services/membership.js). So the storefront
// button is a plain static link, usable by logged-out visitors:
//   <a href="https://.../join/redirect?plan=gold">Join Gold</a>

export function createJoinRouter({ config, razorpay, log }) {
  const router = Router();

  function resolvePlan(planKey) {
    if (!planKey) {
      const err = new Error(`plan is required. Known plans: ${Object.keys(config.plans).join(', ')}`);
      err.statusCode = 400;
      throw err;
    }
    const plan = config.plans[planKey];
    if (!plan) {
      const err = new Error(`unknown plan "${planKey}". Known plans: ${Object.keys(config.plans).join(', ')}`);
      err.statusCode = 400;
      throw err;
    }
    return plan;
  }

  function createSubscriptionFor(plan) {
    return razorpay.createSubscription({
      planId: plan.razorpayPlanId,
      planKey: plan.key,
      planTag: plan.tag,
    });
  }

  router.post('/', async (req, res) => {
    const { plan: planKey } = req.body ?? {};
    try {
      const plan = resolvePlan(planKey);
      const { subscriptionId, shortUrl } = await createSubscriptionFor(plan);
      log.info('subscription created', { subscriptionId, plan: plan.key, tag: plan.tag });
      res.status(200).json({ subscriptionId, shortUrl });
    } catch (err) {
      log.error('join failed', { error: err.message, plan: planKey });
      res.status(err.statusCode ?? 502).json({ error: err.message });
    }
  });

  // Plain-link variant so the storefront button needs zero JS.
  router.get('/redirect', async (req, res) => {
    const { plan: planKey } = req.query;
    try {
      const plan = resolvePlan(planKey);
      const { subscriptionId, shortUrl } = await createSubscriptionFor(plan);
      log.info('subscription created (redirect flow)', { subscriptionId, plan: plan.key, tag: plan.tag });
      res.redirect(302, shortUrl);
    } catch (err) {
      log.error('join redirect failed', { error: err.message, plan: planKey });
      res.redirect(302, config.join.failureUrl);
    }
  });

  return router;
}
