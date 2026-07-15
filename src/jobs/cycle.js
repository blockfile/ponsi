'use strict';

const config = require('../config');
const repo = require('../db/repository');
const { claimCreatorFees } = require('../evm/pons');
const { buyToken } = require('../evm/uniswap');
const { burnToken } = require('../evm/burn');
const { getWethBalanceEth, unwrapAllWeth } = require('../evm/erc20');

/**
 * One buyback-and-burn cycle (fired by the scheduler every minute; skipped
 * upstream when nothing is claimable):
 *
 *   claim TOKEN creator fees from the NOXA fee vault (paid in WETH)
 *     → buy TOKEN with BUY_PCT of the claim (Uniswap V3)
 *     → BURN those tokens (send to DEAD_ADDRESS — out of circulation forever)
 *     → unwrap the remaining WETH to native ETH, kept in the wallet for gas
 *
 * Each step is recorded; a thrown step fails the cycle without crashing.
 * @returns {Promise<object>} the persisted cycle (with steps)
 */
async function runCycle() {
  const id = await repo.createCycle({ dryRun: config.dryRun });
  const log = (msg) => console.log(`[cycle ${id}] ${msg}`);

  try {
    if (!config.tokenAddress) throw new Error('TOKEN_ADDRESS is required');

    // 1. Claim creator fees (WETH).
    const claim = await claimCreatorFees();
    await repo.addStep({ cycleId: id, name: 'claim', status: 'ok', signature: claim.signature, detail: { ethClaimed: claim.ethClaimed } });
    log(`claimed ${claim.ethClaimed} ETH`);

    // Spend the wallet's WHOLE WETH balance — this claim plus any residue stranded
    // by a previously failed cycle. In DRY_RUN there is no real WETH, so use the
    // simulated claim amount.
    const claimed = claim.ethClaimed;
    const walletWeth = config.dryRun ? claimed : await getWethBalanceEth().catch(() => claimed);
    if (!(walletWeth > 0)) {
      await repo.finishCycle(id, { status: 'skipped', eth_claimed: claimed, note: 'nothing claimed' });
      log('skipped: nothing to work with');
      return repo.getCycleWithSteps(id);
    }

    // 2. Buy the token with BUY_PCT of the claim; the rest stays as WETH for gas.
    const buyPortion = +(walletWeth * (config.buyPct / 100)).toFixed(9);
    log(`buy ${buyPortion} WETH (${config.buyPct}%), keep ${+(walletWeth - buyPortion).toFixed(9)} for gas`);

    const buy = await buyToken(config.tokenAddress, buyPortion);
    await repo.addStep({ cycleId: id, name: 'buy', status: 'ok', signature: buy.signature, detail: { ethSpent: buyPortion, tokensBought: buy.tokensBought } });
    log(`bought ${buy.tokensBought} ${config.tokenSymbol} with ${buyPortion} WETH`);

    // 3. Burn everything we just bought.
    const burn = await burnToken(config.tokenAddress, buy.tokensBoughtRaw);
    await repo.addStep({ cycleId: id, name: 'burn', status: 'ok', signature: burn.signature, detail: { tokensBurned: burn.burned, burnedRaw: burn.burnedRaw, deadAddress: burn.deadAddress } });
    log(`burned ${burn.burned} ${config.tokenSymbol} → ${burn.deadAddress}`);

    // 4. Unwrap the WETH remainder to native ETH so the wallet keeps paying gas.
    // Best-effort — never fails the cycle.
    await unwrapAllWeth().catch((err) => log(`unwrap remainder failed (non-fatal): ${err.message}`));

    // 5. Done.
    await repo.finishCycle(id, {
      status: 'complete',
      mode: 'buyback-burn',
      eth_claimed: claimed,
      eth_spent_buy: buyPortion,
      tokens_bought: buy.tokensBought,
      tokens_burned: burn.burned,
      burn_sig: burn.signature,
    });
    log('complete (buyback-burn)');
    return repo.getCycleWithSteps(id);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await repo.addStep({ cycleId: id, name: 'error', status: 'failed', detail: { message } });
    await repo.finishCycle(id, { status: 'failed', error: message });
    log(`FAILED: ${message}`);
    return repo.getCycleWithSteps(id);
  }
}

module.exports = { runCycle };
