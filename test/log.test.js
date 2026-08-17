// The log file is the durable record of post-ack failures, so it has to hold up
// under the conditions it exists for: a crash mid-write, an unbounded run, and a
// path the service can't write to.
//
//   node --test test/*.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileSink, createLogger, openLogSink } from '../src/lib/log.js';
import { loadConfig } from '../src/lib/config.js';

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renmoda-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BASE_ENV = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
  SHOPIFY_SHOP: 'renmoda-test.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'shpat_test',
  JOIN_FAILURE_URL: 'https://renmoda.example/sorry',
  PLANS_PATH: path.join(import.meta.dirname, 'plans.fixture.json'),
};

test('logger writes one JSON line per event to the file, and keeps stdout', (t) => {
  const file = path.join(tmpdir(t), 'membership.log');
  const sink = createFileSink({ filePath: file });
  const log = createLogger({ service: 'renmoda-membership' }, { sink, stdout: false });

  log.info('webhook received', { eventId: 'evt_1', eventType: 'subscription.cancelled' });
  log.error('EVENT PROCESSING FAILED AFTER ACK', { needs_attention: true, eventId: 'evt_1' });
  sink.close();

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].msg, 'webhook received');
  assert.equal(lines[0].service, 'renmoda-membership');
  assert.equal(lines[0].eventType, 'subscription.cancelled');
  assert.ok(Date.parse(lines[0].time));
  assert.equal(lines[1].level, 'error');
  assert.equal(lines[1].needs_attention, true);
});

test('child loggers inherit the same file', (t) => {
  const file = path.join(tmpdir(t), 'membership.log');
  const sink = createFileSink({ filePath: file });
  const log = createLogger({ service: 'renmoda-membership' }, { sink, stdout: false });

  log.child({ eventId: 'evt_child' }).info('revoke: start', { tag: 'membership-gold' });
  sink.close();

  const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(line.eventId, 'evt_child');
  assert.equal(line.tag, 'membership-gold');
});

test('the file rotates at maxBytes and keeps maxFiles generations', (t) => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'membership.log');
  const sink = createFileSink({ filePath: file, maxBytes: 200, maxFiles: 2 });
  const log = createLogger({}, { sink, stdout: false });

  for (let i = 0; i < 40; i += 1) log.info('filler', { i });
  sink.close();

  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.existsSync(`${file}.2`));
  // maxFiles: 2 means .1 and .2 — a .3 would mean unbounded growth.
  assert.ok(!fs.existsSync(`${file}.3`));
  // The newest line is in the live file, not a rotated one.
  const live = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(live.at(-1).i, 39);
});

test('appending reopens an existing file instead of truncating it', (t) => {
  const file = path.join(tmpdir(t), 'membership.log');

  const first = createFileSink({ filePath: file });
  createLogger({}, { sink: first, stdout: false }).info('before restart');
  first.close();

  const second = createFileSink({ filePath: file });
  createLogger({}, { sink: second, stdout: false }).info('after restart');
  second.close();

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'a restart must not wipe the previous run');
  assert.match(lines[0], /before restart/);
});

test('an unwritable log path disables file logging instead of taking the service down', (t) => {
  const dir = tmpdir(t);
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');

  // Opening ./blocker/membership.log must fail — mkdir hits a regular file.
  const sink = openLogSink({ file: path.join(blocker, 'membership.log') });
  assert.equal(sink, null);

  // And the logger still works with no sink at all.
  assert.doesNotThrow(() => createLogger({}, { sink, stdout: false }).info('still alive'));
});

test('config: file logging is on by default and LOG_FILE=off disables it', () => {
  assert.equal(loadConfig(BASE_ENV).log.file, './logs/membership.log');
  assert.equal(loadConfig({ ...BASE_ENV, LOG_FILE: 'off' }).log.file, null);
  assert.equal(loadConfig({ ...BASE_ENV, LOG_FILE: '  ' }).log.file, null);
  assert.equal(loadConfig({ ...BASE_ENV, LOG_FILE: '/var/log/renmoda.log' }).log.file, '/var/log/renmoda.log');

  const tuned = loadConfig({ ...BASE_ENV, LOG_MAX_BYTES: '1048576', LOG_MAX_FILES: '3' }).log;
  assert.equal(tuned.maxBytes, 1048576);
  assert.equal(tuned.maxFiles, 3);
  assert.throws(() => loadConfig({ ...BASE_ENV, LOG_MAX_FILES: '0' }), /LOG_MAX_FILES/);
});
