# minipengs-bot

Mints from `MinipengsNFT` (`0xb6f2e19F5a8de2FbBDEA1d33A0E8965e77999bD4`) on Robinhood Chain
the moment the owner flips `mintActive` to `true`. Five pre-funded wallets each mint the
per-wallet maximum of 2, then `sweep` consolidates all 10 NFTs to a single recipient.

The mint is a stealth launch: no scheduled start, no announcement. The bot polls
`mintStats()` and fires pre-signed, pre-framed transactions the instant `active` goes
non-zero.

## How it stays fast

Everything that can be computed before the trigger is computed before the trigger. At
trigger time the only work is writing already-serialised bytes to already-open sockets.

| Stage | When |
|---|---|
| Nonce fetch, `mintedBy` check | startup, then every 60 s |
| Transaction signing | startup (and again on any nonce change) |
| JSON-RPC body serialisation | startup |
| Full HTTP/1.1 request framing | startup |
| TLS sockets opened (one per tx per endpoint) | startup, kept hot every 20 s |
| **At the trigger** | **`socket.write(frame)` × 10** |

Measured on this machine: **dispatch 0.77–0.96 ms** for 10 requests, **trigger→dispatch
1.6–3.5 ms**.

Node's `https.request` costs ~0.2 ms of synchronous work per call, which alone blows the
1 ms budget for 10 requests. `src/fastlane.ts` therefore keeps raw TLS sockets with the
complete HTTP request pre-built as bytes. It is a speed path, not a correctness path: any
socket that is not ready falls back to the ordinary `https` client, and receipts are
polled by the locally-computed tx hash, so a response-parsing problem can never lose a
transaction.

## Setup

```bash
npm ci && npm run build
```

Copy `.env.example` to `.env` and fill in `PK_0` … `PK_4`. Keys are generated **offline by
the operator** — this bot never generates keys and never logs them.

Fund each wallet with **0.0030 ETH** (0.0150 total). The hard minimum is 0.00256 ETH
(`0.0022` value + `180000 × 2 gwei` reservation); below 0.0030 the sweep gas gets tight.

## Commands

```bash
npm run doctor      # preflight; exits non-zero on any FAIL
npm run simulate    # proves the mint would succeed right now, via a state override
npm run presign     # sign and print tx hashes, no broadcast
npm run dry-fire    # full pipeline against an artificial trigger, no broadcast
npm run watch       # the real thing
npm run sweep       # consolidate NFTs to RECIPIENT
node dist/src/index.js sweep --dust   # return leftover native balance
```

`watch` refuses to broadcast unless `ARMED=true`. Unarmed it runs the entire loop and logs
`WOULD FIRE`, so you can deploy days early and confirm stability with no risk.

### Order of operations before arming

1. `npm run build` — clean, `strict: true`
2. `npm test` — 26 unit tests
3. `npm run doctor` — must be 0 FAIL with all five wallets funded
4. `npm run simulate` — must report ~133,000 gas for every wallet
5. `npm run dry-fire` — dispatch < 1 ms, trigger→dispatch < 5 ms
6. Deploy with `ARMED=false`, watch the heartbeat for a while
7. Set `ARMED=true`

## Verified against the live chain

Confirmed by this build, not assumed:

- `eth_chainId` → `0x1237` (4663)
- contract has 8,794 bytes of code
- `mintStats()` → `minted=1 cap=5000 price=1100000000000000 maxPerWallet=2 sold=0 wallets=1 active=0 raised=1100000000000000`
- sequencer rejects `eth_blockNumber` with `-32601` (send-only, as documented)
- recipient `0x31F7E03c…` has no code (EOA)
- storage slot 7 = `0x…000563df358ca867875cda6144353dbe5cfd7c72838` — owner packed with `mintActive = 0`
- state overrides **are** supported; overriding slot 7 makes `mintActive()` return 1
- both endpoints honour HTTP keep-alive (RPC replies chunked, sequencer with content-length)

### Two corrections to the build spec

**1. The example value hex was wrong.** The spec's `simulate` example used
`"value": "0x7d1a3c8bd0000"`, which is 2,200,826,214,678,528 wei — not 2.2e15. `mint()`
reverts with `WrongValue()` on it. The correct encoding is **`0x7d0e36a818000`**. The code
derives the value from `PRICE_WEI × QUANTITY` and never hardcodes the hex string.

**2. The dry-fire trigger condition could hang forever.** The spec suggested firing when
`blockNumber % 50 === 0`. Block time (~103 ms) is close to the poll RTT, so a poller
observes only a fraction of blocks — measured live, **30 of 145, with gaps up to 6** — and
blocks exactly divisible by 50 are routinely skipped. The first implementation sat for
70+ seconds without triggering. `dry-fire` now fires when the block number *crosses* a
multiple of 50, which keeps the ~5 s cadence and is actually observable.

This does **not** affect the real trigger: `mintStats()` reports current state and `active`
stays true once flipped, so it cannot be missed between blocks.

### Gas, re-measured

Simulated live with the slot-7 override:

| | spec | measured |
|---|---|---|
| `mint(1)` | 107,366 | 107,430 |
| `mint(2)` | 132,964 | **133,028** |

Both are comfortably under the 180,000 limit. The 64-gas delta does not change anything.

## Fee policy — do not tune

```
maxPriorityFeePerGas = 1 gwei
maxFeePerGas         = 2 gwei
```

1 gwei is 2× the highest priority fee ever observed on this chain, and block space is not
contested (block gas limit is 2⁵⁰). A node checks `balance ≥ gasLimit × maxFeePerGas + value`
before accepting a transaction; that reservation is checked but never spent, so raising the
ceiling only forces dead capital into every wallet. There is no fee oracle and no gas
escalator in this codebase, deliberately.

Actual cost per mint: 133,028 × ~1.02 gwei ≈ **0.000136 ETH ≈ $0.26**.

## Railway

Worker service, no public port. `railway.json` sets `restartPolicyType: ON_FAILURE` — a
clean exit after a successful mint must not respawn the bot into a second round of
reverting transactions.

- **Confirm the service does not idle-suspend.** A sleeping poller is a dead poller.
- **Do not push to the deploy branch while armed.** A push redeploys and kills the process.
- **Pick the region by measurement.** `doctor` prints a latency profile and warns above a
  60 ms median. From a home connection this build measured a 215 ms median; a well-placed
  region should be far lower. If nothing gets under ~60 ms, consider Fly.io for precise
  region pinning.
- **Treat all five keys as burned afterwards.** They live in a third-party dashboard.
  Sweep everything out and never reuse them.

## Known risks

These are documented deliberately rather than coded around.

- **`cutSupply(uint256)`** — the owner can reduce max supply after the mint opens.
  Combined with `withdraw()`, that is a live rug vector.
- **`setBaseURI(string)` is unfrozen** — metadata stays mutable until `freezeMetadata()`
  is called.
- **The owner is anonymous with no track record.** `0x563df358…` had 4 lifetime
  transactions, all on 2026-08-18, holding ~0.011 ETH — the contract was deployed the day
  before this build.
- **At least 8 addresses have been firing reverting `mint()` calls** at this contract since
  deployment. You are not the only bot watching. They spray blind and eat reverts; this bot
  polls and fires clean, but nothing guarantees you land first.
- **Consolidating to one recipient makes the five-wallet cluster trivially linkable
  on-chain.** Accepted trade-off, recorded here on purpose.
- **Five wallets to get around `MAX_PER_WALLET = 2` is deliberate circumvention** of the
  contract's per-wallet fairness cap. It is not an exploit — it calls a public function
  exactly as written — but projects do blacklist sybil clusters and revoke holder benefits.
  If this collection ever matters, this pattern is visible forever.

## Layout

```
src/
  index.ts       subcommand dispatch, watch flow
  config.ts      env parsing + validation, all verified constants
  rpc.ts         keep-alive JSON-RPC client + socket warmer
  fastlane.ts    raw TLS sockets with pre-framed HTTP requests
  dispatcher.ts  binds pre-signed txs to sockets; the fire() call
  stats.ts       mintStats() encode/decode
  presign.ts     build + sign + serialise the mint txs
  poller.ts      pipelined trigger loop and the latch
  blast.ts       dispatch, classify responses, poll receipts
  sweep.ts       discover tokens, transfer to recipient, dust sweep
  doctor.ts      preflight checks
  simulate.ts    state-override gas simulation
  log.ts         ms-precision structured logging
```

Dependencies are `ethers` and `dotenv`, nothing else. Every additional package is
supply-chain risk sitting next to five funded private keys.
