'use strict';

// Build the set of owner addresses excluded from PONS airdrops: the operating
// wallet, the dead address, the Pons locker, the PONS reward token, the Pons
// factory, the PONZI liquidity pool (fetched live), plus any AIRDROP_EXCLUDE
// extras. All lowercased for case-insensitive matching.

const config = require('../config');
const { wallet } = require('./provider');
const { launcherToken } = require('./pons');

async function buildExcludeSet(token = config.tokenAddress) {
  const set = new Set();
  const add = (a) => {
    if (a) set.add(String(a).toLowerCase());
  };

  add(wallet.address);
  add(config.deadAddress);
  add(config.ponsLocker);
  add(config.ponsFactory);
  add(config.rewardToken);
  for (const a of config.airdropExclude) add(a);

  // The PONZI/WETH pool holds PONZI as reserves — never a real holder.
  if (!config.dryRun && token) {
    try {
      add(await launcherToken(token).liquidityPool());
    } catch (_err) {
      // pool address unavailable — skip
    }
  }
  return set;
}

module.exports = { buildExcludeSet };
