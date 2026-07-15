'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('config exposes the buyback-burn defaults', () => {
  const config = require('./config');
  assert.strictEqual(config.buyPct, 80);
  assert.strictEqual(config.slippagePct, 5);
  assert.strictEqual(config.pollSchedule, '*/1 * * * *');
  assert.strictEqual(config.claimThresholdUsd, 0);
  assert.strictEqual(config.dryRunFeePerPoll, 0.01);
  assert.strictEqual(config.chainId, 4663);
  assert.strictEqual(config.creatorFeeSharePct, 35);
  assert.strictEqual(config.deadAddress, '0x000000000000000000000000000000000000dead');
});

test('BUY_PCT and DEAD_ADDRESS are overridable', () => {
  delete require.cache[require.resolve('./config')];
  process.env.BUY_PCT = '90';
  process.env.DEAD_ADDRESS = '0x000000000000000000000000000000000000DEAD';
  const config = require('./config');
  assert.strictEqual(config.buyPct, 90);
  assert.strictEqual(config.deadAddress, '0x000000000000000000000000000000000000dead');
  delete process.env.BUY_PCT;
  delete process.env.DEAD_ADDRESS;
  delete require.cache[require.resolve('./config')];
});
