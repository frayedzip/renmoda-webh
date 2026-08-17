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
//
// IDENTITY IS ASYMMETRIC AND THAT IS THE HAZARD: a grant identifies the member
// by `payload.payment.entity.email` (the email on the payment), while a revoke
// has no payment entity and must fall back to the email on the Razorpay CUSTOMER
// record. Those are two different fields on two different objects and Razorpay
// does not guarantee they match — the customer record can carry a different
// address, or none at all (UPI-only checkouts). When they diverge, the Shopify
// lookup at revoke time finds nobody and the tag stays on a cancelled member.
// So every grant now writes the subscription id -> Shopify customer link into
// membership_log, and a revoke falls back to that link before giving up.

export function createMembershipService({ config, store, shopify, razorpay, log }) {
  // Every tag this service is allowed to touch. Exactly the plans.json catalog —
  // no prefix matching, so a hand-applied tag that merely looks membership-ish
  // is never stripped. A membership ends -> all of these come off; anything else
  // on the customer (wholesale, newsletter, …) is left alone.
  const catalogTags = Object.values(config.plans).map((plan) => plan.tag);

  // The tag in notes is what THIS subscription granted, so it comes off even if
  // the catalog has since been renamed and no longer lists it.
  function membershipTagsToClear(grantedTag) {
    return [...new Set([...catalogTags, grantedTag].filter(Boolean))];
  }

  function subscriptionIdOf(body) {
    return body?.payload?.subscription?.entity?.id ?? null;
  }

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
    const subscriptionId = subscriptionIdOf(body);
    const email = await resolveEmail(body);
    if (!email) {
      // `charged` always carries a payment email; if we still can't resolve one
      // that's a real problem. `activated` legitimately has none yet — the
      // first `charged` (which follows) will grant, so defer quietly.
      if (emailRequired) {
        throw new Error('Cannot resolve member email on a charge event (no payment email, no Razorpay customer email)');
      }
      log.info('grant deferred: no email yet, awaiting first charge', {
        ...ctx,
        subscriptionId,
        plan: planKey,
      });
      return;
    }

    const { gid, created, invite } = await shopify.findOrCreateCustomer(email);

    // Add before removing: if the second call fails the member briefly holds two
    // plan tags, which is harmless. The other order would strip their access and
    // then fail to restore it.
    const tagsAfterAdd = await shopify.addTag(gid, tag);
    // Switching tiers replaces the tag rather than stacking: clear every other
    // catalog tag, never the one we just granted.
    const supersededTags = catalogTags.filter((candidate) => candidate !== tag);
    const tagsAfterSwap = await shopify.removeTags(gid, supersededTags);
    // subscriptionId + email are what make this row reversible later — without
    // them a revoke has no way back to this customer.
    store.logMembership({
      eventId: ctx.eventId,
      eventType: ctx.eventType,
      shopifyCustomerId: gid,
      action: 'tag_added',
      tag,
      note: `plan ${planKey ?? '(unknown)'}${created ? ' (new customer, invited)' : ''}`,
      subscriptionId,
      email,
    });
    log.info('plan tag granted', {
      ...ctx,
      subscriptionId,
      customerGid: gid,
      email,
      plan: planKey,
      tag,
      supersededTags,
      customerTags: tagsAfterSwap ?? tagsAfterAdd,
      newCustomer: created,
      inviteSent: created ? invite?.sent : undefined,
    });
  }

  // Every branch here logs. A revoke that does nothing used to be indis-
  // tinguishable from a revoke that never arrived; since we've already 200'd the
  // event by this point, Razorpay will never redeliver it and these lines are
  // the only account of what happened.
  async function revoke(body, ctx, reason) {
    const { tag, planKey } = extractPlanTag(body);
    const subscriptionId = subscriptionIdOf(body);
    const trace = { ...ctx, subscriptionId, plan: planKey, tag, reason };
    log.info('revoke: start', trace);

    // A Razorpay API blip must not block an untag we can resolve locally, so
    // this failure is recorded and we carry on to the grant-history fallback.
    let email = null;
    try {
      email = await resolveEmail(body);
    } catch (err) {
      log.warn('revoke: Razorpay customer lookup failed, falling back to grant history', {
        ...trace,
        customerId: body?.payload?.subscription?.entity?.customer_id ?? null,
        error: err.message,
      });
    }

    let gid = null;
    let identifiedVia = null;

    if (email) {
      gid = await shopify.findCustomerByEmail(email);
      if (gid) {
        identifiedVia = 'razorpay_email';
      } else {
        log.warn('revoke: no Shopify customer matches the Razorpay email', { ...trace, email });
      }
    } else {
      log.warn('revoke: Razorpay yielded no email for this member', { ...trace });
    }

    // The link written at grant time. This is the branch that catches the
    // payment-email vs customer-email divergence described at the top.
    const priorGrant = gid ? null : store.findLastGrant(subscriptionId);
    if (priorGrant) {
      gid = priorGrant.shopifyCustomerId;
      identifiedVia = 'grant_history';
      log.info('revoke: recovered the customer from this subscription\'s grant history', {
        ...trace,
        customerGid: gid,
        razorpayEmail: email,
        grantedToEmail: priorGrant.email,
        grantedAt: priorGrant.createdAt,
      });
    }

    if (!gid) {
      // Neither route found anyone. Two readings: the subscription was never
      // charged (nothing was ever tagged — harmless), or it was granted under an
      // email we can no longer resolve (the member is still tagged). We cannot
      // tell them apart here, and only one of them is safe, so this fails loud.
      throw new Error(
        `Cannot identify the Shopify customer to untag on ${ctx.eventType} ` +
          `(subscription ${subscriptionId ?? 'unknown'}, razorpay email ${email ?? 'unresolved'}, ` +
          `no grant recorded for this subscription) — plan tag "${tag}" NOT removed. ` +
          'Check Shopify for this member: if the subscription was never charged no tag was ever ' +
          'applied and this is safe to ignore; otherwise remove the tag by hand.'
      );
    }

    // The membership is over, so every plan tag comes off — not just the one
    // this subscription granted. Non-membership tags are untouched.
    const clearedTags = membershipTagsToClear(tag);
    const customerTags = await shopify.removeTags(gid, clearedTags);
    store.logMembership({
      eventId: ctx.eventId,
      eventType: ctx.eventType,
      shopifyCustomerId: gid,
      action: 'tag_removed',
      tag,
      note: `${reason} (identified via ${identifiedVia}; cleared ${clearedTags.join(', ')})`,
      subscriptionId,
      email: email ?? priorGrant?.email ?? null,
    });
    log.info('plan tag revoked', {
      ...trace,
      customerGid: gid,
      email: email ?? priorGrant?.email ?? null,
      identifiedVia,
      clearedTags,
      customerTags,
    });
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
