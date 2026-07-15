'use strict';

// Airdrop a reward token (PONS) to weighted allocations [{owner, amountRaw}].
// Sends in batches and records every recipient (repo.addAirdrop) so partial
// failures are visible and retriable. Two send paths:
//   - DISPERSE_ADDRESS set → one tx per batch via a disperse contract
//     (disperseToken(token, recipients[], values[])); the token must be
//     pre-approved to the disperse contract.
//   - otherwise → sequential ERC-20 transfers, one tx per recipient.
// DRY_RUN simulates the sends (no chain calls).

const { Contract, formatUnits } = require('ethers');
const config = require('../config');
const repo = require('../db/repository');
const { wallet } = require('./provider');
const { erc20, getDecimals } = require('./erc20');
const { sendTx } = require('./send');

const DISPERSE_ABI = ['function disperseToken(address token, address[] recipients, uint256[] values)'];

function chunk(arr, n) {
  const out = [];
  const size = Math.max(1, n | 0);
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function airdropToken({ rewardToken, allocations, cycleId }) {
  if (!allocations || allocations.length === 0) return { sent: 0, failed: 0 };

  const decimals = config.dryRun ? 18 : await getDecimals(rewardToken);
  const uiOf = (raw) => Number(formatUnits(BigInt(raw), decimals));
  const batches = chunk(allocations, config.airdropBatchSize);

  let sent = 0;
  let failed = 0;
  for (const batch of batches) {
    const sigByRecipient = new Map();
    let status = 'ok';
    try {
      if (config.dryRun) {
        const s = fakeSig('airdrop');
        for (const a of batch) sigByRecipient.set(a.owner, s);
      } else if (config.disperseAddress) {
        const disperse = new Contract(config.disperseAddress, DISPERSE_ABI, wallet);
        const recipients = batch.map((a) => a.owner);
        const values = batch.map((a) => BigInt(a.amountRaw));
        // Resend on a stale-nonce reject (RPC lag after the buy tx) — see send.js.
        const tx = await sendTx(() => disperse.disperseToken(rewardToken, recipients, values));
        await tx.wait();
        for (const a of batch) sigByRecipient.set(a.owner, tx.hash);
      } else {
        const token = erc20(rewardToken, wallet);
        for (const a of batch) {
          // Resend on a stale-nonce reject (RPC lag after the buy tx) — see send.js.
          const tx = await sendTx(() => token.transfer(a.owner, BigInt(a.amountRaw)));
          await tx.wait();
          sigByRecipient.set(a.owner, tx.hash);
        }
      }
    } catch (err) {
      status = 'failed';
      console.error(`[airdrop] batch failed: ${err.message}`);
    }

    for (const a of batch) {
      const signature = status === 'ok' ? sigByRecipient.get(a.owner) || null : null;
      await repo.addAirdrop({
        cycleId,
        rewardToken,
        recipient: a.owner,
        amountRaw: a.amountRaw,
        amountUi: uiOf(a.amountRaw),
        signature,
        status,
      });
      if (status === 'ok') sent += 1;
      else failed += 1;
    }
  }
  return { sent, failed };
}

module.exports = { airdropToken, chunk };
