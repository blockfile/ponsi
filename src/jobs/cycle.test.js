'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('runCycle (DRY_RUN): claim → buy → burn', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  process.env.BUY_PCT = '80';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'noxaliqui_test_cycle';
  const db = require('../db/index');
  const repo = require('../db/repository');
  const simvault = require('../evm/simvault');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    simvault.reset(0.05); // creator-fee vault has fees to claim
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'complete');
    assert.strictEqual(cycle.mode, 'buyback-burn');

    const names = cycle.steps.map((s) => s.name);
    assert.deepStrictEqual(names, ['claim', 'buy', 'burn']);

    // 80% of the claim is spent buying; the same tokens are then burned.
    assert.ok(cycle.eth_claimed > 0);
    assert.ok(Math.abs(cycle.eth_spent_buy - cycle.eth_claimed * 0.8) < 1e-6, '80% spent on the buy');
    assert.ok(cycle.tokens_bought > 0);
    assert.strictEqual(cycle.tokens_burned, cycle.tokens_bought, 'burns exactly what it bought');
    assert.ok(cycle.burn_sig, 'records the burn tx');

    const burn = cycle.steps.find((s) => s.name === 'burn');
    assert.strictEqual(burn.detail.deadAddress, '0x000000000000000000000000000000000000dead');

    const stats = await repo.getStats();
    assert.strictEqual(stats.burns, 1);
    assert.ok(stats.total_tokens_burned > 0);
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
    delete process.env.BUY_PCT;
  }
});

test('runCycle (DRY_RUN): nothing claimable → skipped', async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  delete require.cache[require.resolve('../config')];
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'noxaliqui_test_skip';
  const db = require('../db/index');
  const simvault = require('../evm/simvault');
  const { runCycle } = require('./cycle');
  await db.connect();
  try {
    simvault.reset(0); // empty vault
    const cycle = await runCycle();
    assert.strictEqual(cycle.status, 'skipped');
    assert.ok(cycle.steps.some((s) => s.name === 'claim'));
    assert.ok(!cycle.steps.some((s) => s.name === 'buy'));
  } finally {
    await db.close();
    await mongod.stop();
    delete require.cache[require.resolve('../config')];
  }
});
