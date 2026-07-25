// Config loading, focused on the plans catalog validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/lib/config.js';

const PLANS_FIXTURE = fileURLToPath(new URL('./plans.fixture.json', import.meta.url));

function baseEnv(over = {}) {
  return {
    RAZORPAY_KEY_ID: 'k',
    RAZORPAY_KEY_SECRET: 's',
    RAZORPAY_WEBHOOK_SECRET: 'wh',
    SHOPIFY_SHOP: 's.myshopify.com',
    SHOPIFY_ADMIN_TOKEN: 'shpat_real',
    JOIN_SUCCESS_URL: 'https://x/ok',
    JOIN_FAILURE_URL: 'https://x/fail',
    PLANS_PATH: PLANS_FIXTURE,
    ...over,
  };
}

// Write a throwaway plans file and return its path.
function tmpPlans(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
  const p = path.join(dir, 'plans.json');
  fs.writeFileSync(p, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return p;
}

test('loads a valid plan catalog and ignores _comment keys', () => {
  const config = loadConfig(baseEnv());
  assert.deepEqual(Object.keys(config.plans).sort(), ['gold', 'silver']);
  assert.equal(config.plans.gold.razorpayPlanId, 'plan_gold_test');
  assert.equal(config.plans.gold.tag, 'membership-gold');
  assert.equal(config.plans.gold.key, 'gold');
});

test('a _comment-annotated catalog still loads (comment is not a plan)', () => {
  const p = tmpPlans({ _comment: 'notes here', gold: { razorpayPlanId: 'plan_x', tag: 't' } });
  const config = loadConfig(baseEnv({ PLANS_PATH: p }));
  assert.deepEqual(Object.keys(config.plans), ['gold']);
});

test('missing plans file throws a clear error', () => {
  assert.throws(
    () => loadConfig(baseEnv({ PLANS_PATH: '/no/such/plans.json' })),
    /cannot read plans file/
  );
});

test('an empty catalog is rejected', () => {
  const p = tmpPlans({});
  assert.throws(() => loadConfig(baseEnv({ PLANS_PATH: p })), /defines no plans/);
});

test('a comment-only catalog is rejected (no real plans)', () => {
  const p = tmpPlans({ _comment: 'nothing here' });
  assert.throws(() => loadConfig(baseEnv({ PLANS_PATH: p })), /defines no plans/);
});

test('a plan missing its tag is rejected', () => {
  const p = tmpPlans({ gold: { razorpayPlanId: 'plan_x' } });
  assert.throws(() => loadConfig(baseEnv({ PLANS_PATH: p })), /missing "tag"/);
});

test('a plan missing its razorpayPlanId is rejected', () => {
  const p = tmpPlans({ gold: { tag: 'membership-gold' } });
  assert.throws(() => loadConfig(baseEnv({ PLANS_PATH: p })), /missing "razorpayPlanId"/);
});

test('invalid JSON is rejected with a clear error', () => {
  const p = tmpPlans('{ not valid json ');
  assert.throws(() => loadConfig(baseEnv({ PLANS_PATH: p })), /not valid JSON/);
});
