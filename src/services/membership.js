import { normalizeCustomerGid } from './shopify.js';

// Business logic per Razorpay event.
//
// Monthly behaviour is RESET, not top-up: debit the wallet to zero, then
// credit the allowance. A top-up would let members bank multiple months and
// pull 8-12 garments at once; membership means "4 items this month", not
// "4 items I can accumulate". The reset fires off subscription.charged (never
// a 30-day cron) so credit stays in lockstep with money actually collected —
// a retried/failed charge naturally delays the fresh credit.

export function createMembershipService({ config, store, shopify, log }) {
  const allowanceStr = config.membership.allowance.toFixed(2);
  const currency = config.membership.currency;
  const tag = config.membership.activeTag;

  function extractCustomerGid(body) {
    const rawId = body?.payload?.subscription?.entity?.notes?.shopify_customer_id;
    if (!rawId) {
      // Without notes.shopify_customer_id we have no idea whose wallet this
      // is. That means the subscription was created outside POST /join —
      // a human needs to trace it, not code.
      throw new Error(
        'Webhook payload has no notes.shopify_customer_id — subscription was not created via /join'
      );
    }
    return normalizeCustomerGid(rawId);
  }

  // Debit existing balance to zero, then credit the full allowance.
  // Done as two explicit ledger entries (not a computed delta) so the audit
  // trail reads exactly like the business rule: "wiped old month, granted new".
  async function resetCredit(customerGid, { eventId, eventType }) {
    const account = await shopify.getStoreCreditAccount(customerGid);
    const existing = account ? Number.parseFloat(account.balance.amount) : 0;

    if (account && existing > 0) {
      const debited = await shopify.debitStoreCredit(account.id, existing.toFixed(2));
      store.logCredit({
        eventId,
        eventType,
        shopifyCustomerId: customerGid,
        action: 'debit',
        amount: existing.toFixed(2),
        currency,
        balanceAfter: debited.balance.amount,
        note: 'monthly reset: clear unspent balance',
      });
    }

    const credited = await shopify.creditStoreCredit(customerGid, allowanceStr);
    store.logCredit({
      eventId,
      eventType,
      shopifyCustomerId: customerGid,
      action: 'credit',
      amount: allowanceStr,
      currency,
      balanceAfter: credited.balance.amount,
      note: 'monthly allowance',
    });

    return credited.balance;
  }

  async function zeroCredit(customerGid, { eventId, eventType }) {
    const account = await shopify.getStoreCreditAccount(customerGid);
    const existing = account ? Number.parseFloat(account.balance.amount) : 0;
    if (!account || existing <= 0) return;

    const debited = await shopify.debitStoreCredit(account.id, existing.toFixed(2));
    store.logCredit({
      eventId,
      eventType,
      shopifyCustomerId: customerGid,
      action: 'debit',
      amount: existing.toFixed(2),
      currency,
      balanceAfter: debited.balance.amount,
      note: 'membership ended: revoke remaining credit',
    });
  }

  async function grant(customerGid, ctx) {
    const balance = await resetCredit(customerGid, ctx);
    await shopify.addTag(customerGid, tag);
    log.info('membership granted', { ...ctx, customerGid, balance: balance.amount });
  }

  async function revoke(customerGid, ctx, reason) {
    await shopify.removeTag(customerGid, tag);
    if (config.membership.revokeCreditOnEnd) {
      await zeroCredit(customerGid, ctx);
    }
    log.info('membership revoked', {
      ...ctx,
      customerGid,
      reason,
      creditRevoked: config.membership.revokeCreditOnEnd,
    });
  }

  return {
    async handleEvent(eventType, body, eventId) {
      const ctx = { eventId, eventType };

      switch (eventType) {
        case 'subscription.activated':
        case 'subscription.charged':
          // activated = mandate approved + first charge; charged = renewal.
          // Both mean "money just arrived", so both grant the fresh month.
          await grant(extractCustomerGid(body), ctx);
          break;

        case 'subscription.pending':
          // Grace window: Razorpay is still retrying the charge (transient
          // bank/UPI declines are common). Revoking here punishes members for
          // their bank's flakiness — only `halted` means retries exhausted.
          log.info('payment pending, grace window — no action', {
            ...ctx,
            subscriptionId: body?.payload?.subscription?.entity?.id,
          });
          break;

        case 'subscription.halted':
          await revoke(extractCustomerGid(body), ctx, 'payment retries exhausted');
          break;

        case 'subscription.cancelled':
          await revoke(extractCustomerGid(body), ctx, 'member cancelled autopay');
          break;

        case 'subscription.completed':
          await revoke(extractCustomerGid(body), ctx, 'subscription term completed');
          break;

        default:
          log.info('unhandled event type, ignoring', ctx);
      }
    },
  };
}
