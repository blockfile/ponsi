'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { claimCreatorFees } = require('../evm/pons');
const { buyToken } = require('../evm/uniswap');
const { burnToken } = require('../evm/burn');
const { getWethBalanceEth, unwrapAllWeth, getTokenSupplyRaw, readTokenBalance } = require('../evm/erc20');
const { snapshotEligibleHolders } = require('../evm/holders');
const { buildExcludeSet } = require('../evm/exclude');
const { computeWeightedAllocations } = require('../services/distribution');
const { airdropToken } = require('../evm/airdrop');

/**
 * Reward leg: buy the reward token (PONS) with `wethAmount`, snapshot eligible
 * holders of `holderToken` (PONZI) once (>= minHold, exclusions applied), and
 * airdrop the tokens bought THIS cycle pro-rata by holdings (optional per-wallet
 * cap via capPct + cluster grouping). Distribution weights by holder balance but
 * distributes only the amount bought this cycle, never a holder's own balance.
 */
async function runRewardLeg(cycleId, { holderToken, rewardToken, wethAmount, minHold, capPct, clusters }) {
  const log = (m) => console.log(`[cycle ${cycleId}] [reward] ${m}`);

  const buy = await buyToken(rewardToken, wethAmount);
  await repo.addStep({
    cycleId,
    name: 'buy',
    status: 'ok',
    signature: buy.signature,
    detail: { leg: 'reward', token: rewardToken, ethSpent: wethAmount, tokensBought: buy.tokensBought },
  });
  log(`bought ${buy.tokensBought} ${config.rewardSymbol} with ${wethAmount} WETH`);

  const minHoldRaw = (BigInt(Math.trunc(minHold)) * 10n ** 18n).toString(); // PONZI: 18 decimals
  const exclude = await buildExcludeSet(holderToken);
  const { holders, totalHolders } = await snapshotEligibleHolders({ token: holderToken, minHoldRaw, exclude });
  log(`${holders.length} eligible holders (>= ${minHold}) of ${totalHolders} total`);

  const supplyRaw = capPct == null ? null : (await getTokenSupplyRaw(holderToken)).toString();
  const allocations = computeWeightedAllocations(holders, buy.tokensBoughtRaw || '0', { capPct, supplyRaw, clusters });
  const air = await airdropToken({ rewardToken, allocations, cycleId });
  await repo.addStep({
    cycleId,
    name: 'airdrop',
    status: air.failed ? 'failed' : 'ok',
    detail: { token: rewardToken, recipients: allocations.length, sent: air.sent, failed: air.failed },
  });
  log(`airdrop ${config.rewardSymbol} sent=${air.sent} failed=${air.failed}`);

  return {
    tokensBought: buy.tokensBought,
    sent: air.sent,
    failed: air.failed,
    eligibleHolders: holders.length,
    totalHolders,
  };
}

/**
 * One reward-and-burn cycle (fired by the scheduler; skipped upstream when
 * nothing is claimable):
 *
 *   claim PONZI creator fees from the pons.family locker (paid in WETH)
 *     → REWARD_BUY_PCT: buy PONS and airdrop it to PONZI holders (pro-rata)
 *     → BURN_PCT:       buy PONZI and burn it (+ any PONZI token-side fees)
 *     → remainder:      unwrap the leftover WETH to native ETH (dev cut + gas)
 *
 * Each step is recorded; a thrown step fails the cycle without crashing.
 * @returns {Promise<object>} the persisted cycle (with steps)
 */
async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS (PONZI) is required');
    if (!config.rewardToken) throw new Error('REWARD_TOKEN (PONS) is required');

    // 1. Claim creator fees (WETH).
    const claim = await claimCreatorFees();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { ethClaimed: claim.ethClaimed } });
    log(`claimed ${claim.ethClaimed} ETH`);

    // Spend the wallet's WHOLE WETH balance (this claim plus any residue). In
    // DRY_RUN there is no real WETH, so use the simulated claim amount.
    const claimed = claim.ethClaimed;
    const walletWeth = config.dryRun ? claimed : await getWethBalanceEth().catch(() => claimed);
    if (!(walletWeth > 0)) {
      await repo.finishCycle(id, { status: 'skipped', eth_claimed: claimed, note: 'nothing claimed' });
      log('skipped: nothing to work with');
      return repo.getCycleWithSteps(id);
    }

    const eth = (pct) => +(walletWeth * (pct / 100)).toFixed(9);
    const rewardEth = eth(config.rewardBuyPct);
    const burnEth = eth(config.burnPct);
    const devEth = +(walletWeth - rewardEth - burnEth).toFixed(9);
    log(`split: ${rewardEth} → PONS reward (${config.rewardBuyPct}%), ${burnEth} → PONZI burn (${config.burnPct}%), keep ${devEth} for dev/gas`);

    // 2. Reward leg — buy PONS + airdrop to PONZI holders.
    let reward = { sent: 0, failed: 0, tokensBought: 0, eligibleHolders: 0, totalHolders: 0 };
    if (rewardEth > 0) {
      reward = await runRewardLeg(id, {
        holderToken: config.tokenAddress,
        rewardToken: config.rewardToken,
        wethAmount: rewardEth,
        minHold: config.minHold,
        capPct: config.rewardCapPct > 0 ? config.rewardCapPct : null,
        clusters: config.clusters,
      });
    }

    // 3. Burn leg — buy PONZI with burnEth and burn it. By default burn ONLY the
    //    buyback; set BURN_TOKEN_SIDE_FEES=true to also burn the PONZI token-side
    //    creator fees that accrue to the wallet each claim.
    let burned = 0;
    let burnSig = null;
    if (burnEth > 0) {
      const buyBurn = await buyToken(config.tokenAddress, burnEth);
      await repo.addStep({ cycleId: id, name: 'buy', status: 'ok', signature: buyBurn.signature, detail: { leg: 'burn', token: config.tokenAddress, ethSpent: burnEth, tokensBought: buyBurn.tokensBought } });
      const toBurnRaw = config.dryRun || !config.burnTokenSideFees
        ? buyBurn.tokensBoughtRaw
        : (await readTokenBalance(config.tokenAddress, config.wallet.address)).toString();
      const burn = await burnToken(config.tokenAddress, toBurnRaw);
      await repo.addStep({ cycleId: id, name: 'burn', status: 'ok', signature: burn.signature, detail: { tokensBurned: burn.burned, burnedRaw: burn.burnedRaw, deadAddress: burn.deadAddress } });
      burned = burn.burned;
      burnSig = burn.signature;
      log(`burned ${burn.burned} ${config.tokenSymbol} → ${burn.deadAddress}`);
    }

    // 4. Dev cut — unwrap the WETH remainder to native ETH (kept for gas + dev).
    //    Best-effort — never fails the cycle.
    await unwrapAllWeth().catch((err) => log(`unwrap remainder failed (non-fatal): ${err.message}`));

    // 5. Done.
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'reward-burn',
      eth_claimed: claimed,
      eth_spent_buy: rewardEth,
      tokens_bought: reward.tokensBought,
      tokens_burned: burned,
      burn_sig: burnSig,
      eligible_holders: reward.eligibleHolders,
      total_holders: reward.totalHolders,
      note: `airdrop sent ${reward.sent}`,
    });
    log('complete (reward-burn)');
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle, runRewardLeg };
