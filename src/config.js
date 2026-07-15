'use strict';

require('dotenv').config();

const { Wallet } = require('ethers');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const DRY_RUN = bool(process.env.DRY_RUN, true);

/**
 * Load the signing wallet (0x-prefixed hex private key). It must be the wallet
 * that deployed the token on NOXA Fun — the creator fee share is paid to the
 * deployer address. In DRY_RUN with no key configured, an ephemeral wallet is
 * generated so the server runs out of the box (no funds are ever touched).
 */
function loadWallet() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    if (!DRY_RUN) {
      throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false');
    }
    return { wallet: Wallet.createRandom(), ephemeral: true };
  }
  try {
    const key = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
    return { wallet: new Wallet(key), ephemeral: false };
  } catch (err) {
    throw new Error(`Could not parse WALLET_PRIVATE_KEY: ${err.message}`);
  }
}

const { wallet, ephemeral: walletIsEphemeral } = loadWallet();

const lowerOrNull = (v) => (v ? String(v).trim().toLowerCase() : null);

const config = {
  port: num(process.env.PORT, 3000),
  dryRun: DRY_RUN,

  // Robinhood Chain mainnet defaults.
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: num(process.env.CHAIN_ID, 4663),
  explorerApi: (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),

  wallet,
  walletIsEphemeral,

  // NOXA Fun contracts (Robinhood Chain deployments; override per chain).
  noxaFactory: process.env.NOXA_FACTORY || '0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB',
  noxaLocker: process.env.NOXA_LOCKER || '0x7F03effbd7ceB22A3f80Dd468f67eF27826acD85',
  noxaFeeVault: process.env.NOXA_FEE_VAULT || '0x9eFdC1A8e6E94f16A228e44f3025E1f346EE0417',
  weth: process.env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  swapRouter: process.env.SWAP_ROUTER || '0xCaf681a66D020601342297493863E78C959E5cb2',
  // Observed creator share of the WETH-side LP fees paid by collect() — used only
  // to estimate the claimable balance; the actual payout is whatever the vault sends.
  creatorFeeSharePct: num(process.env.CREATOR_FEE_SHARE_PCT, 35),

  // The token you launched on NOXA Fun. Its creator fees fund the cycle; the bot
  // buys it and burns it.
  tokenAddress: lowerOrNull(process.env.TOKEN_ADDRESS),
  tokenSymbol: process.env.TOKEN_SYMBOL || 'TOKEN',

  // ── Buyback-and-burn loop ────────────────────────────────────────────────
  // Each claim: buy the token with BUY_PCT of the claimed WETH and burn those
  // tokens (send to DEAD_ADDRESS — out of circulation forever). The remaining
  // (100 - BUY_PCT)% is unwrapped to native ETH and kept in the wallet to pay
  // transaction gas.
  buyPct: num(process.env.BUY_PCT, 80), // % of each claim used to buy (then burn) the token
  slippagePct: num(process.env.SLIPPAGE_PCT, 5), // Uniswap V3 buy-swap slippage, percent
  gasReserveEth: num(process.env.GAS_RESERVE_ETH, 0.005), // native ETH never wrapped/spent on the buy
  // Burn sink for the bought tokens. Default is the canonical EVM dead address.
  deadAddress: lowerOrNull(process.env.DEAD_ADDRESS) || '0x000000000000000000000000000000000000dead',

  // Trigger — the scheduler checks on this timer (default every minute) and
  // runs a cycle only once the claimable fees reach CLAIM_THRESHOLD_USD. Set the
  // threshold to 0 to claim whatever has accrued on every tick (the old timer mode).
  pollSchedule: process.env.POLL_SCHEDULE || '*/1 * * * *',
  // Default 0 → buy-and-burn every minute on whatever fees accrued. Raise it to
  // batch claims until they are worth $N (saves gas when fees are tiny).
  claimThresholdUsd: num(process.env.CLAIM_THRESHOLD_USD, 0),
  // DRY_RUN only: simulated ETH added to the fee vault each tick, so cycles have
  // something to claim without real fees.
  dryRunFeePerPoll: num(process.env.DRY_RUN_FEE_PER_POLL, 0.01),

  // DexScreener chain slug for /stats market data (graceful nulls until listed).
  dexscreenerChainId: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',

  // Storage (MongoDB)
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'noxaliqui',

  // CORS allowlist (comma-separated). Default: localhost dev origins. Set to your
  // frontend domain(s) in production, or "*" to allow any origin.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Secret protecting the POST control endpoints. Blank = open (dev); set in prod.
  apiKey: process.env.API_KEY || null,
};

module.exports = config;
