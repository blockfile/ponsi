'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

// One mongo server for the whole file: config.mongoUri is captured when db/index
// first loads config, so a second connect() in the same process would point at
// the first (stopped) server. Both scenarios share one connection.
let mongod;
let db;
let repo;
let simvault;
let runCycle;

before(async () => {
  process.env.DRY_RUN = 'true';
  process.env.TOKEN_ADDRESS = '0x00000000000000000000000000000000000a1b69';
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = 'ponsliqui_test_cycle';
  delete require.cache[require.resolve('../config')];
  db = require('../db/index');
  repo = require('../db/repository');
  simvault = require('../evm/simvault');
  ({ runCycle } = require('./cycle'));
  await db.connect();
});

after(async () => {
  await db.close();
  await mongod.stop();
  delete require.cache[require.resolve('../config')];
  delete process.env.TOKEN_ADDRESS;
});

test('runCycle (DRY_RUN): claim → buy PONS + airdrop → buy PONZI + burn → dev', async () => {
  simvault.reset(0.05); // creator-fee vault has fees to claim
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'complete');
  assert.strictEqual(cycle.mode, 'reward-burn');

  // reward leg (buy PONS + airdrop) then burn leg (buy PONZI + burn).
  const names = cycle.steps.map((s) => s.name);
  assert.deepStrictEqual(names, ['claim', 'buy', 'airdrop', 'buy', 'burn']);

  assert.ok(cycle.eth_claimed > 0);
  // 80% buys PONS (the reward buy is recorded as eth_spent_buy).
  assert.ok(Math.abs(cycle.eth_spent_buy - cycle.eth_claimed * 0.8) < 1e-6, '80% spent on the reward buy');
  assert.ok(cycle.tokens_bought > 0, 'bought PONS');
  assert.ok(cycle.tokens_burned > 0, 'burned PONZI');

  // Two simulated eligible holders (operating wallet excluded).
  assert.strictEqual(cycle.eligible_holders, 2);
  assert.strictEqual(cycle.total_holders, 3);
  const airdrop = cycle.steps.find((s) => s.name === 'airdrop');
  assert.strictEqual(airdrop.detail.sent, 2);
  assert.strictEqual(airdrop.detail.failed, 0);

  // Airdrop rows persisted for the PONS reward token.
  const totals = await repo.getAirdropTotals();
  const rewardTotals = Object.values(totals)[0];
  assert.strictEqual(rewardTotals.holders, 2);
  assert.strictEqual(rewardTotals.sends, 2);
});

test('runCycle (DRY_RUN): nothing claimable → skipped', async () => {
  simvault.reset(0); // empty vault
  const cycle = await runCycle();
  assert.strictEqual(cycle.status, 'skipped');
  assert.ok(cycle.steps.some((s) => s.name === 'claim'));
  assert.ok(!cycle.steps.some((s) => s.name === 'buy'));
});
