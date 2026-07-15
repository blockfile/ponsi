# ponsliqui

**Creator-fee reward bot for pons.family on Robinhood Chain (EVM).**

Recycles your PONZI token's creator fees, every claim, into three streams:

```
claim PONZI creator fees (WETH)  — collectFees() on the pons.family locker
  → 80%  buy PONS   (Uniswap V3)  → airdrop to PONZI holders (pro-rata, ≥100k)
  → 10%  buy PONZI  (Uniswap V3)  → BURN it  (send to 0x…dEaD, + token-side fees)
  → 10%  unwrap to native ETH     → kept in the wallet (dev cut + gas)
```

Everything runs in `DRY_RUN=true` by default — all on-chain calls are simulated
and no funds are ever touched until you flip it off.

## The three legs

- **Reward (80%):** buys **PONS** (`0x39dBED…`) and airdrops it to holders of your
  **PONZI** token, weighted pro-rata by holdings. Only wallets holding
  **≥ `MIN_HOLD` (100,000)** PONZI are eligible; the operating wallet, dead
  address, pool, locker, and reward token are excluded. Optional per-wallet cap
  (`REWARD_CAP_PCT`) and cluster grouping (`CLUSTERS`).
- **Burn (10%):** buys **PONZI** and sends it to the dead address — permanently
  out of circulation. Any PONZI paid to you as token-side fees is burned too.
- **Dev (10%):** the remainder is unwrapped to native ETH and kept in the wallet
  for gas + the dev cut.

## How the pons.family fee claim works (verified on-chain)

pons.family deploys each token straight into a Uniswap V3 pool (1% fee tier) and
locks the LP in its **PonsLaunchLocker**. Trading fees accrue in that position.
The claim path:

- Call `collectFees(address token)` on the locker
  (`0x736D76699C26D0d966744cAe304C000d471f7F35`). It collects the position's
  fees, takes the protocol share (`tokenProtocolFeeShares`, ~10%), and pays the
  creator remainder of **both** sides to the token's fee recipient — the
  **deployer** by default. So the operating wallet **must be the wallet that
  deployed PONZI on pons.family**; the WETH share lands there.

### Robinhood Chain reference (defaults in `.env.example`)

| What | Value |
|---|---|
| Chain ID | 4663 |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Pons Factory | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` |
| Pons Locker (`collectFees`) | `0x736D76699C26D0d966744cAe304C000d471f7F35` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| PONS reward token | `0x39dBED3a2bd333467115dE45665cC57F813C4571` |

## Config

| Env | Default | Meaning |
|---|---|---|
| `REWARD_BUY_PCT` | `80` | % of each claim used to buy PONS + airdrop it |
| `BURN_PCT` | `10` | % of each claim used to buy + burn PONZI (dev = the rest) |
| `MIN_HOLD` | `100000` | minimum PONZI balance to qualify for the airdrop |
| `REWARD_CAP_PCT` | `0` | per-wallet airdrop weight cap, % of supply (0 = pure pro-rata) |
| `TRIGGER_MODE` | `interval` | `interval` (every tick) or `accumulation` (by ETH threshold) |
| `POLL_SCHEDULE` | `*/5 * * * *` | how often the scheduler ticks (every 5 minutes) |
| `CLAIM_EVERY_ETH` | `0.005` | accumulation mode: fire once claimable ≥ this (ETH) |
| `SLIPPAGE_PCT` | `5` | Uniswap V3 buy-swap slippage tolerance |
| `DEAD_ADDRESS` | `0x…dEaD` | burn sink for the bought PONZI |
| `AIRDROP_BATCH_SIZE` | `150` | recipients per airdrop batch |
| `DISPERSE_ADDRESS` | — | batch-transfer contract; blank → sequential transfers |

## Trigger modes

- **`interval`** (default): a cycle runs every `POLL_SCHEDULE` tick (every 5 min)
  on whatever fees have accrued.
- **`accumulation`**: the timer still ticks, but a cycle only fires once the
  claimable balance reaches `CLAIM_EVERY_ETH` (e.g. `0.005`). `POST /api/run`
  always bypasses the gate.

## Quick start

```bash
npm install
cp .env.example .env       # defaults are safe: DRY_RUN=true, ephemeral wallet
npm start                  # needs MongoDB (local mongod or set MONGODB_URI)
npm test                   # unit + integration tests (in-memory MongoDB)
```

## Going live

1. Launch your PONZI token on pons.family **from the operating wallet**.
2. Fill `.env`: `WALLET_PRIVATE_KEY` (the deployer key), `TOKEN_ADDRESS`,
   `MONGODB_URI`, set `DRY_RUN=false`. Fund the wallet with a little native ETH
   for gas. Ensure fees are **not** redirected away from the wallet.
3. `node scripts/check.js` — read-only preflight (verifies the deployer matches,
   fee-redirect target, claimable fees).
4. Dust-test the legs (`--confirm` to send):
   - `node scripts/claim.js --confirm`
   - `node scripts/buy.js 0.001 --confirm`
   - `node scripts/burn.js 0.001 --confirm`
5. `node scripts/run-once.js --confirm` — one full cycle, then `npm start`.

## API

Storage (MongoDB), the Express API (`/activity`, `/stats`, `/summary`,
`/accrual`, `/countdown`, `/api/status`, `/api/cycles`, `/api/airdrops`,
`/api/transactions`, SSE stream, `POST /api/run|pause|resume`) and the scheduler
are the shared infra from the sibling ports.

## Design

See [`docs/superpowers/specs/2026-07-15-ponsliqui-pons-pivot-design.md`](docs/superpowers/specs/2026-07-15-ponsliqui-pons-pivot-design.md)
and the plan in [`docs/superpowers/plans/`](docs/superpowers/plans/).
