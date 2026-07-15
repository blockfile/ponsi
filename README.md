# noxaliqui

**Buyback-and-burn bot on NOXA Fun / Robinhood Chain (EVM).**

Recycles your token's creator fees into buying and burning your own token, every
minute:

```
claim creator fees (WETH)
  → buy your token with 80% of the claim   (Uniswap V3)
  → BURN those tokens  (send to 0x…dEaD — out of circulation forever)
  → the remaining 20% is unwrapped to native ETH and kept in the wallet for gas
```

Everything runs in `DRY_RUN=true` by default — all on-chain calls are simulated
and no funds are ever touched until you flip it off.

## What "burn" means here

The bot sends the tokens it just bought to the **dead address** (`0x…dEaD`). The
dead address has no private key, so those tokens can never move again — they're
permanently out of circulation, and show up as burned on the explorer. This
works for any ERC-20 (no `burn()` function required on the token). If your token
has a real `burn()` that reduces total supply, that can be swapped in — say so.

## How the NOXA fee claim works (verified on-chain)

NOXA Fun deploys each token straight into a Uniswap V3 pool (1% fee tier) and
parks the LP in its Launch Locker. Trading fees accrue there. The claim path
(reverse-engineered from live Robinhood Chain transactions):

- Anyone calls `collect(address token)` (selector `0x06ec16f8`) on the fee vault.
- The creator share (~35% of the WETH side) is sent directly to the token's
  **deployer** address. So the operating wallet **must be the wallet that
  deployed the token on NOXA Fun**. The claim lands as WETH.

### Robinhood Chain reference (defaults in `.env.example`)

| What | Value |
|---|---|
| Chain ID | 4663 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| NOXA Factory | `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB` |
| NOXA Fee Vault (`collect`) | `0x9eFdC1A8e6E94f16A228e44f3025E1f346EE0417` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |

Other NOXA chains (Monad, MegaETH, …) use the same architecture — point the
contract addresses + RPC at that chain via env vars.

## Config

| Env | Default | Meaning |
|---|---|---|
| `BUY_PCT` | `80` | % of each claim used to buy + burn the token (rest kept for gas) |
| `SLIPPAGE_PCT` | `5` | Uniswap V3 buy-swap slippage tolerance |
| `POLL_SCHEDULE` | `*/1 * * * *` | how often the scheduler ticks (every minute) |
| `CLAIM_THRESHOLD_USD` | `0` | `0` = act every minute on whatever accrued; raise to batch claims |
| `DEAD_ADDRESS` | `0x…dEaD` | burn sink for the bought tokens |
| `GAS_RESERVE_ETH` | `0.005` | native ETH kept back for gas |

## Quick start

```bash
npm install
cp .env.example .env       # defaults are safe: DRY_RUN=true, ephemeral wallet
npm start                  # needs a local MongoDB (or set MONGODB_URI)
npm test                   # unit + integration tests (in-memory MongoDB)
```

## Going live

1. Launch your token on <https://fun.noxa.fi/robinhood> **from the operating wallet**.
2. Fill `.env`: `WALLET_PRIVATE_KEY` (the deployer key), `TOKEN_ADDRESS`,
   `MONGODB_URI`, set `DRY_RUN=false`. Fund the wallet with a little native ETH
   for gas.
3. `node scripts/check.js` — read-only preflight (verifies the deployer matches,
   reads claimable fees).
4. Dust-test the legs (`--confirm` to send):
   - `node scripts/claim.js --confirm`
   - `node scripts/buy.js 0.001 --confirm`
   - `node scripts/burn.js 0.001 --confirm` — buys dust and burns it. **Verify on
     the explorer that the tokens landed at the dead address.**
5. `node scripts/run-once.js --confirm` — one full cycle, then `npm start` for
   the every-minute loop.

## Scripts

| Script | What it does |
|---|---|
| `scripts/check.js` | Read-only preflight: config, RPC/chain, balances, NOXA launch record, claimable fees |
| `scripts/claim.js` | Claim creator fees (`--confirm` to send) |
| `scripts/buy.js <eth>` | Buy the token with N ETH (`--confirm` to send) |
| `scripts/burn.js <eth>` | Buy dust + burn it (`--confirm` to send) |
| `scripts/run-once.js` | One full claim → buy → burn cycle (`--confirm`) |

## What changed vs. the Solana `liqui`

| Solana `liqui` | This bot |
|---|---|
| pump.fun `collectCoinCreatorFee` | NOXA fee vault `collect(token)` → WETH to deployer |
| buy on bonding curve / PumpSwap | Uniswap V3 `exactInputSingle` (WETH → token) |
| add liquidity + lock LP forever | **buy + burn the token** (send to the dead address) |
| keep some SOL in reserve | keep ~20% as native ETH for gas |

Storage (MongoDB), the Express API (`/activity`, `/stats`, `/summary`,
`/accrual`, `/countdown`, `/api/*`, SSE stream) and the scheduler are the shared
infra from the `noxatest` port.

## Design

See [`docs/superpowers/specs/2026-07-11-noxaliqui-locked-liquidity-design.md`](docs/superpowers/specs/2026-07-11-noxaliqui-locked-liquidity-design.md)
(section 0 documents the pivot from locked-liquidity to buyback-burn).
