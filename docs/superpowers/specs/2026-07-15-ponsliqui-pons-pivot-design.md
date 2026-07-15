# ponsliqui — NOXA → pons.family pivot + reward-airdrop engine

**Date:** 2026-07-15
**Status:** Approved
**Supersedes:** the buyback-burn direction in
`2026-07-11-noxaliqui-locked-liquidity-design.md` (kept as history).

## 0. Summary

Pivot the bot completely off **NOXA Fun** and onto **pons.family** (a separate,
near-identical launchpad on Robinhood Chain — same Uniswap V3 deployment, same
WETH, `getLaunchedToken` struct byte-identical, fees claimed via
`collectFees(token)` on the Pons locker instead of a fee vault's `collect(token)`).

At the same time, replace the single buyback-burn action with a **three-way
reward engine** modelled on the sibling `cupsy` project (claim → buy reward token
→ pro-rata airdrop to holders):

- **80%** → buy **PONS** and airdrop it to **PONZI** holders (≥ 100,000), pro-rata.
- **10%** → buy **PONZI** and burn it (dead address).
- **10%** → stays in the operating wallet as native ETH (dev cut + gas).

Full rebrand: every `noxa` reference removed; internal project name → `ponsliqui`
(the on-disk repo folder stays `noxaliqui` — cannot rename the workspace).

## 1. Token roles

| Role | Token | Address | Notes |
|---|---|---|---|
| Holder token | **PONZI** | `TOKEN_ADDRESS` (deployed later on pons.family) | Its creator fees fund every cycle. Symbol `PONZI`. |
| Reward token | **PONS** | `0x39dBED3a2bd333467115dE45665cC57F813C4571` | Bought with 80%, airdropped to PONZI holders. Verified ERC-20, 18 decimals, 1% WETH V3 pool. |

## 2. Verified Pons contracts (Robinhood Chain, chainId 4663)

| Config key | Address |
|---|---|
| `ponsFactory` (was `noxaFactory`) — `getLaunchedToken(address)` | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` |
| `ponsLocker` (was `noxaLocker`) — `collectFees(address token)` | `0x736D76699C26D0d966744cAe304C000d471f7F35` |
| `weth` (unchanged) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| `swapRouter` (unchanged — same Uniswap as bot config) | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| ~~`noxaFeeVault`~~ | **removed** — Pons claims on the locker, no separate vault |

`collectFees(token)` is callable by the token's **deployer** (the operating
wallet), pays the creator remainder of both fee sides to the deployer (or a
`feeRedirects[token]` wallet if set), and takes `tokenProtocolFeeShares[token]`
(default 10%) as protocol fee. The exact WETH received is still measured from the
receipt's WETH `Transfer` logs to the wallet.

## 3. The cycle (each claim)

Base amount = **claimed WETH**. Order and error handling follow the existing
`cycle.js` (each step recorded; a thrown step fails the cycle without crashing).

1. **Claim** — `collectFees(TOKEN_ADDRESS)` on `ponsLocker`. Read WETH received.
2. **Reward leg (80%)** — buy PONS on Uniswap V3 (1% tier) with 80% of the WETH;
   snapshot eligible PONZI holders (≥ `MIN_HOLD`, exclusions applied); airdrop the
   PONS **bought this cycle** pro-rata by PONZI holdings (largest-remainder integer
   math; optional per-wallet cap `REWARD_CAP_PCT` and `CLUSTERS`, both off by
   default). Distribution weights by holder balance but distributes only the amount
   bought this cycle — never a holder's own balance.
3. **Burn leg (10%)** — buy PONZI with 10% of the WETH and burn it (transfer to
   `DEAD_ADDRESS`). Any **PONZI token-side fees** received in the claim are burned
   here too (we never hold PONZI).
4. **Dev cut (remainder, 10%)** — unwrap the leftover WETH to native ETH; it stays
   in the operating wallet (dev cut + gas reserve).

Split config: `REWARD_BUY_PCT=80`, `BURN_PCT=10`; dev = `100 - REWARD_BUY_PCT -
BURN_PCT`. Validated to be ≥ 0 and ≤ 100 at load.

## 4. Switchable trigger

`POLL_SCHEDULE` always drives the timer tick; `TRIGGER_MODE` decides the gate:

- `TRIGGER_MODE=interval` (default): fire every tick on whatever accrued.
  Default `POLL_SCHEDULE=*/5 * * * *` (5 minutes).
- `TRIGGER_MODE=accumulation`: fire only when claimable ≥ `CLAIM_EVERY_ETH`
  (e.g. `0.005`). Replaces the old `CLAIM_THRESHOLD_USD` gate (removed).
- `POST /api/run` always bypasses the gate (manual `triggerNow`).

The claimable estimate reads uncollected LP fees (static-call the position manager
as the locker) and applies the creator remainder derived from
`tokenProtocolFeeShares(token)` (fallback `PROTOCOL_FEE_SHARE_PCT=10`). DRY_RUN
uses the simulated vault.

## 5. Modules

**Reused unchanged / near-verbatim:**
- `src/services/distribution.js` — `computeWeightedAllocations` copied verbatim
  from cupsy (chain-agnostic BigInt largest-remainder; cap + clusters).
- `src/evm/uniswap.js` — `buyToken` buys both PONS and PONZI; unchanged.
- `src/evm/burn.js` — dead-address ERC-20 transfer; unchanged.

**New (EVM ports of cupsy):**
- `src/evm/holders.js` — `snapshotEligibleHolders({ token, minHoldRaw, exclude })`
  via the Blockscout holders API (`GET {EXPLORER_API}/api/v2/tokens/{token}/holders`,
  paginated by `next_page_params`). Returns `{ holders:[{owner,balanceRaw}],
  totalHolders }`. Pure `filterEligible` / `countOwners` helpers (ported).
  DRY_RUN returns simulated holders so cycles exercise the path.
- `src/evm/airdrop.js` — `airdropToken({ rewardToken, allocations, cycleId })`.
  Batched via a **disperse-style batch transfer** (see §6). Persists every
  recipient (`repo.addAirdrop`), returns `{ sent, failed }`. DRY_RUN simulates.

**Rewritten:**
- `src/evm/pons.js` (was `noxa.js`) — `collectFees` claim, factory reads,
  claimable estimate, DRY_RUN simvault.
- `src/jobs/cycle.js` — three-way split (reward leg + burn leg + dev), using a
  `runRewardLeg` helper like cupsy's.
- `src/jobs/scheduler.js` — `TRIGGER_MODE` + `CLAIM_EVERY_ETH` gate.
- `src/db/repository.js` — `addAirdrop`, `airdrops` collection, airdrop stats,
  `getAirdrops(limit, offset, token)`.
- `src/config.js` — new keys (below); remove `noxaFeeVault`, `claimThresholdUsd`.
- `src/routes/*` — add `GET /api/airdrops` and `/airdrops`; airdrop/holder fields
  in status, stats, summary.

## 6. Airdrop execution

PONZI may have many eligible holders; one ERC-20 transfer per holder every cycle
is impractical on EVM. Airdrop via a **batch disperse call**: approve PONS to the
disperse contract once, then `disperse(token, recipients[], amounts[])` chunked at
`AIRDROP_BATCH_SIZE` (~150) recipients per tx.

- If Robinhood Chain has an existing Disperse deployment, use it (verify address).
- Otherwise deploy a minimal batch-transfer contract (≈20 lines: loop
  `transferFrom(sender, recipients[i], amounts[i])`) and record its address in
  `.env` as `DISPERSE_ADDRESS`.
- Fallback (small holder counts / no disperse): chunked sequential `transfer`s
  with nonce management.

Each recipient send is persisted with `status` ok/failed so partial failures are
visible and retriable; a failed batch does not fail the cycle.

## 7. Default airdrop exclusions

Excluded from eligibility: operating/deployer wallet, `DEAD_ADDRESS`, the PONZI
Uniswap pool + Pons locker, the PONS contract, and any `AIRDROP_EXCLUDE` extras
(comma-separated). Pool/locker hold PONZI but are not real holders.

## 8. Config / `.env` additions

```
# Launchpad (pons.family — Robinhood Chain)
PONS_FACTORY=0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB
PONS_LOCKER=0x736D76699C26D0d966744cAe304C000d471f7F35
WETH_ADDRESS=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
SWAP_ROUTER=0xCaf681a66D020601342297493863E78C959E5cb2
PROTOCOL_FEE_SHARE_PCT=10

# Tokens
TOKEN_ADDRESS=                     # PONZI (your token, deployed on pons.family)
TOKEN_SYMBOL=PONZI
REWARD_TOKEN=0x39dBED3a2bd333467115dE45665cC57F813C4571   # PONS (bought + airdropped)
REWARD_SYMBOL=PONS

# Split (of each WETH claim)
REWARD_BUY_PCT=80                  # buy PONS → airdrop to PONZI holders
BURN_PCT=10                        # buy PONZI → burn
# dev cut = 100 - REWARD_BUY_PCT - BURN_PCT (kept as native ETH)

# Airdrop
MIN_HOLD=100000                    # min PONZI to qualify
REWARD_CAP_PCT=0                   # per-wallet weight cap, % of supply (0 = pure pro-rata)
CLUSTERS=[]                        # JSON address-groups treated as one wallet
AIRDROP_EXCLUDE=                   # extra excluded owners, comma-separated
AIRDROP_BATCH_SIZE=150
DISPERSE_ADDRESS=                  # batch-transfer contract (deployed if empty)

# Trigger
TRIGGER_MODE=interval             # interval | accumulation
POLL_SCHEDULE=*/5 * * * *         # timer tick (every 5 min)
CLAIM_EVERY_ETH=0.005             # accumulation mode: fire when claimable >= this
DRY_RUN_FEE_PER_POLL=0.01         # DRY_RUN only

SLIPPAGE_PCT=5
GAS_RESERVE_ETH=0.005
DEAD_ADDRESS=0x000000000000000000000000000000000000dEaD
MONGODB_DB=ponsliqui
```

Removed: `NOXA_FACTORY`, `NOXA_LOCKER`, `NOXA_FEE_VAULT`, `CREATOR_FEE_SHARE_PCT`
(→ `PROTOCOL_FEE_SHARE_PCT`), `CLAIM_THRESHOLD_USD`, `BUY_PCT`. No backward-compat
aliases.

## 9. Rebrand map (full `noxa` removal)

- File `src/evm/noxa.js` → `src/evm/pons.js`; update imports in `cycle.js`,
  `uniswap.js`, `scheduler.js`, `metrics.js`.
- Identity: `package.json` name/description, `MONGODB_DB` default, server log
  prefix `[noxa-rewards]` → `[ponsliqui]`, `/` endpoint text (also fix the stale
  "add + burn (lock) liquidity" wording to the reward-engine description).
- Docs: rewrite `README.md` for pons.family and the reward engine; all "NOXA Fun"
  → "pons.family".
- All comments/strings referencing NOXA → Pons.

## 10. Testing (TDD)

- Port `src/services/distribution.test.js` from cupsy (verbatim).
- New `src/evm/holders.test.js` — Blockscout parse + `filterEligible`/`countOwners`.
- New `src/evm/airdrop.test.js` — batching, persistence, dry-run, partial failure.
- New `src/evm/pons.test.js` — claim calls `collectFees` on the locker (not a
  vault `collect`); claimable estimate.
- Rewrite `src/jobs/cycle.test.js` — three-way split (mock claim/buy/burn/airdrop),
  percentages, token-side burn.
- Rewrite `src/jobs/scheduler.test.js` — `interval` vs `accumulation` gate.
- `npm test` green on in-memory Mongo.

## 11. Out of scope (YAGNI)

- Per-wallet cap + clusters ship but default off.
- On-disk folder rename (internal name only).
- Old locked-liquidity spec kept as a dated historical record.
- Merkle/claim-based airdrop (push model only for v1).
