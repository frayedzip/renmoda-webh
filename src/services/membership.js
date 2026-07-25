// Business logic per Razorpay event.
//
// Identity comes from Razorpay, not from Shopify: the member enters their email
// on Razorpay's hosted page, so we resolve WHO they are from the webhook:
//   - `subscription.charged`/`completed` carry payload.payment.entity.email.
//   - other events (activated/halted/cancelled) have no payment entity, so we
//     fetch the Razorpay customer (payload.subscription.entity.customer_id) for
//     the email.
// From the email we find-or-create the Shopify customer (new ones get an account
// invite) and add/remove the plan tag. The plan tag itself still rides in the
// subscription notes (stamped at /join), so no plan-catalog lookup is needed.
//
// Tagging is idempotent, so the model is: tag when money arrives, untag when the
// membership ends.

export function createMembershipService({ store, shopify, razorpay, log }) {
  function extractPlanTag(body) {
    const notes = body?.payload?.subscription?.entity?.notes ?? {};
    const tag = notes.plan_tag;
    if (!tag) {
      throw new Error(
        'Webhook payload has no notes.plan_tag — cannot determine which plan tag to apply/remove'
      );
    }
    return { tag, planKey: notes.plan ?? null };
  }

  // Email from the payment entity when present, else from the Razorpay customer.
  // Returns null if it genuinely can't be resolved (caller decides severity).
  async function resolveEmail(body) {
    const paymentEmail = body?.payload?.payment?.entity?.email;
    if (paymentEmail) return paymentEmail;
    const customerId = body?.payload?.subscription?.entity?.customer_id;
    return razorpay.fetchCustomerEmail(customerId);
  }

  async function grant(body, ctx, { emailRequired }) {
    const { tag, planKey } = extractPlanTag(body);
    const email = await resolveEmail(body);
    if (!email) {
      // `charged` always carries a payment email; if we still can't resolve one
      // that's a real problem. `activated` legitimately has none yet — the
      // first `charged` (which follows) will grant, so defer quietly.
      if (emailRequired) {
        throw new Error('Cannot resolve member email on a charge event (no payment email, no Razorpay customer email)');
      }
      log.info('grant deferred: no email yet, awaiting first charge', { ...ctx, plan: planKey });
      return;
    }

    const { gid, created, invite } = await shopify.findOrCreateCustomer(email);
    await shopify.addTag(gid, tag);
    store.logMembership({
      eventId: ctx.eventId,
      eventType: ctx.eventType,
      shopifyCustomerId: gid,
      action: 'tag_added',
      tag,
      note: `plan ${planKey ?? '(unknown)'}${created ? ' (new customer, invited)' : ''}`,
    });
    log.info('plan tag granted', {
      ...ctx,
      customerGid: gid,
      email,
      plan: planKey,
      tag,
      newCustomer: created,
      inviteSent: created ? invite?.sent : undefined,
    });
  }

  async function revoke(body, ctx, reason) {
    const { tag, planKey } = extractPlanTag(body);
    const email = await resolveEmail(body);
    if (!email) {
      // We can't identify whom to untag — the member could retain access. Flag
      // loudly for a human rather than silently leaving them tagged.
      throw new Error(
        `Cannot resolve member email on ${ctx.eventType} — plan tag NOT removed, needs manual attention`
      );
    }

    const gid = await shopify.findCustomerByEmail(email);
    if (!gid) {
      log.warn('revoke: no Shopify customer for email, nothing to untag', { ...ctx, email, plan: planKey });
      return;
    }
    await shopify.removeTag(gid, tag);
    store.logMembership({
      eventId: ctx.eventId,
      eventType: ctx.eventType,
      shopifyCustomerId: gid,
      action: 'tag_removed',
      tag,
      note: reason,
    });
    log.info('plan tag revoked', { ...ctx, customerGid: gid, email, plan: planKey, tag, reason });
  }

  return {
    async handleEvent(eventType, body, eventId) {
      const ctx = { eventId, eventType };

      switch (eventType) {
        case 'subscription.charged':
          // Renewal or first charge — always carries the payment email.
          await grant(body, ctx, { emailRequired: true });
          break;

        case 'subscription.activated':
          // Mandate approved; no payment entity. Best-effort — the first charge
          // grants for real.
          await grant(body, ctx, { emailRequired: false });
          break;

        case 'subscription.pending':
          // Grace window: Razorpay is still retrying the charge (transient
          // bank/UPI declines are common). Removing access here punishes members
          // for their bank's flakiness — only `halted` means retries exhausted.
          log.info('payment pending, grace window — no action', {
            ...ctx,
            subscriptionId: body?.payload?.subscription?.entity?.id,
          });
          break;

        case 'subscription.halted':
          await revoke(body, ctx, 'payment retries exhausted');
          break;

        case 'subscription.cancelled':
          await revoke(body, ctx, 'member cancelled autopay');
          break;

        case 'subscription.completed':
          await revoke(body, ctx, 'subscription term completed');
          break;

        default:
          log.info('unhandled event type, ignoring', ctx);
      }
    },
  };
}
