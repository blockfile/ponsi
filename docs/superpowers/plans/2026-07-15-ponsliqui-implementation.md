# ponsliqui Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) to implement task-by-task. Steps use `- [ ]`.

**Goal:** Turn the seeded noxaliqui EVM base into `ponsliqui`: claim PONZI creator fees on pons.family, split each claim 80/10/10 → buy+airdrop PONS to PONZI holders / buy+burn PONZI / dev cut, with a switchable interval|accumulation trigger. Remove all `noxa`.

**Architecture:** Reuse the existing Express + MongoDB + node-cron infra. Adapt the claim leg to Pons's `collectFees` locker call, port the reward engine (holders snapshot, pro-rata distribution, batched airdrop) from the sibling `cupsy` project (Solana → EVM), rewrite the cycle to the three-way split.

**Tech Stack:** Node ≥20, ethers v6, express, mongodb, node-cron; tests via `node --test` + mongodb-memory-server.

## Global Constraints (verbatim from spec §2, §8)
- Chain: Robinhood Chain, chainId 4663. RPC `https://rpc.mainnet.chain.robinhood.com`.
- `ponsFactory=0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`, `ponsLocker=0x736D76699C26D0d966744cAe304C000d471f7F35`, `weth=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, `swapRouter=0xCaf681a66D020601342297493863E78C959E5cb2`.
- Reward token PONS `0x39dBED3a2bd333467115dE45665cC57F813C4571` (18 dec, 1% WETH pool).
- Split: `REWARD_BUY_PCT=80`, `BURN_PCT=10`, dev = remainder. `MIN_HOLD=100000`. `TRIGGER_MODE=interval|accumulation`, `CLAIM_EVERY_ETH=0.005`, `POLL_SCHEDULE=*/5 * * * *`.
- DRY_RUN default true. No `noxa` string anywhere. Internal name `ponsliqui`.
- Reference source to port: `D:\projects\cupsy\src\services\distribution.js`, `...\src\solana\holders.js`, `...\src\solana\airdrop.js`, `...\src\db\repository.js` (airdrops), `...\src\jobs\cycle.js` (runRewardLeg).

---

## File structure
- Modify `src/config.js` — Pons addrs, split, reward token, trigger; drop noxaFeeVault/creatorFeeSharePct/claimThresholdUsd/buyPct.
- Rename `src/evm/noxa.js` → `src/evm/pons.js` — `collectFees` claim; keep exports `getClaimableEth`, `simulateFeeAccrual`, `claimCreatorFees`, `getLaunchedToken`, `launcherToken`, `getUncollectedLpFees`.
- Create `src/services/distribution.js` (+ `.test.js`) — port `computeWeightedAllocations` verbatim from cupsy.
- Create `src/evm/holders.js` (+ `.test.js`) — `snapshotEligibleHolders({token,minHoldRaw,exclude})` via Blockscout `/api/v2/tokens/{t}/holders`; pure `filterEligible`/`countOwners`.
- Create `src/evm/airdrop.js` (+ `.test.js`) — `airdropToken({rewardToken,allocations,cycleId})`, chunked batch transfers, `repo.addAirdrop` per recipient.
- Modify `src/db/repository.js` — `addAirdrop`, `getAirdrops`, airdrop stats.
- Modify `src/evm/uniswap.js` — import `launcherToken` from `./pons`; else unchanged.
- Rewrite `src/jobs/cycle.js` (+ `.test.js`) — 3-way split with `runRewardLeg`.
- Modify `src/jobs/scheduler.js` (+ `.test.js`) — TRIGGER_MODE gate.
- Modify `src/routes/*`, `server.js` — `/api/airdrops` + `/airdrops`, identity, endpoint list, fix stale wording.
- Modify `scripts/check.js`, `scripts/*.js` — Pons preflight (+ feeRedirect check), collectFees.
- Modify `package.json`, `.env.example`, `README.md` — rebrand to ponsliqui/pons.family.

## Tasks (TDD, dependency-ordered)

### Task 1 — config.js
- [ ] Test `src/config.test.js`: pons addresses default; split validates (reward+burn ≤100, dev=remainder); `triggerMode` in {interval,accumulation}; `claimEveryEth` numeric; no `noxa*` keys.
- [ ] Rewrite config.js: add `ponsFactory,ponsLocker,rewardToken,rewardSymbol,rewardBuyPct,burnPct,devPct(derived),minHold,rewardCapPct,clusters,airdropExclude,airdropBatchSize,disperseAddress,triggerMode,claimEveryEth,protocolFeeSharePct`; remove `noxaFeeVault,creatorFeeSharePct,claimThresholdUsd,buyPct`; keep `weth,swapRouter,gasReserveEth,slippagePct,deadAddress,pollSchedule,dryRunFeePerPoll`; `mongoDb` default `ponsliqui`.
- [ ] Run `node --test src/config.test.js`; commit.

### Task 2 — distribution.js
- [ ] Copy cupsy `distribution.js` + `distribution.test.js` verbatim (chain-agnostic). Run test; commit.

### Task 3 — pons.js (claim)
- [ ] `git mv src/evm/noxa.js src/evm/pons.js`; update requires in uniswap.js/scheduler.js/cycle.js/metrics.js.
- [ ] Test `src/evm/pons.test.js`: `claimCreatorFees` (live path, mocked) calls locker `collectFees(token)`, not vault `collect`; reads WETH from logs. `getClaimableEth` estimate uses protocol-share remainder.
- [ ] Replace `VAULT_ABI`/`collect` with `LOCKER_FEE_ABI=['function collectFees(address token) returns (uint256,uint256)']`, call on `config.ponsLocker`; update `getUncollectedLpFees` recipient/from → `ponsLocker`; claimable creator remainder from `tokenProtocolFeeShares(token)` (fallback `protocolFeeSharePct`).
- [ ] Run pons.test.js; commit.

### Task 4 — holders.js
- [ ] Test: `filterEligible` collapses per-owner, drops excluded/below-min; `countOwners`; `snapshotEligibleHolders` DRY_RUN returns sim holders; live parses Blockscout holder page shape `{items:[{address:{hash},value}], next_page_params}`.
- [ ] Implement using `EXPLORER_API`; paginate `next_page_params`. Commit.

### Task 5 — repository.js airdrops
- [ ] Test `src/db/airdrops.test.js` (port cupsy): `addAirdrop` inserts; `getAirdrops` paginates; stats include airdrop totals.
- [ ] Add `airdrops` collection ops + emit `airdrop` event. Commit.

### Task 6 — airdrop.js
- [ ] Test: `airdropToken` chunks allocations by `airdropBatchSize`, records each recipient (ok/failed), DRY_RUN fake sig, returns `{sent,failed}`; empty allocations → `{0,0}`.
- [ ] Implement batched ERC-20 sends (disperse contract if `disperseAddress` set, else chunked `transfer`), persist via `repo.addAirdrop`. Commit.

### Task 7 — cycle.js
- [ ] Rewrite `cycle.test.js`: claim → 80% buy PONS + airdrop, 10% buy PONZI + burn (incl. token-side fees), dev remainder unwrapped; each step recorded; a failed leg fails cycle without crash.
- [ ] Rewrite cycle.js with `runRewardLeg` (snapshot once, buy, distribute) + burn leg + dev. Commit.

### Task 8 — scheduler.js
- [ ] Rewrite `scheduler.test.js`: `interval` fires on any claimable; `accumulation` fires only when claimable ≥ `claimEveryEth`; manual `triggerNow` bypasses; overlap guard.
- [ ] Implement TRIGGER_MODE gate. Commit.

### Task 9 — routes + server.js
- [ ] Add `GET /api/airdrops`; add airdrop/holder fields to status/stats/summary; server identity `[ponsliqui]`, endpoint list, fix stale "lock liquidity" text. Adjust route tests if any. Commit.

### Task 10 — scripts + package.json + .env.example + README
- [ ] Pons preflight in `scripts/check.js` (factory.exists, deployer==wallet, feeRedirect unset/self); collectFees in `scripts/claim.js`; rebrand `package.json`, `.env.example` (spec §8), `README.md`. Commit.

### Task 11 — verify
- [ ] `node --test` all green; `node scripts/check.js` dry-run smoke; commit + push.

## Self-review
Spec coverage: §2 addrs→T1/T3; §3 cycle→T7; §4 trigger→T8; §5 modules→T2-T8; §6 airdrop→T6; §7 exclusions→T4/T1; §8 config→T1/T10; §9 rebrand→T3/T9/T10; §10 tests→each task. No placeholders (port code lives in referenced cupsy files). Types consistent (`{owner,balanceRaw}`, `{owner,amountRaw}`, `airdropToken`, `snapshotEligibleHolders`, `computeWeightedAllocations`).
