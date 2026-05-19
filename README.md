# nonce-miner (CPU)

CPU miner for **$NONCE** — an ERC-8004 Proof-of-Work token on **Base mainnet**.

Computes valid nonces off-chain via native Rust keccak256, submits `mine(nonce)` transactions through ethers.js. Designed to be lightweight, runnable on any VPS.

> **GPU version:** [Nonce-miner-gpu](https://github.com/citojitu/Nonce-miner-gpu) (CUDA, RTX 30/40 series target).

## Contract

- **Address:** [`0xE7bADd12bdf070e925A55A98c981f3aBAB4f20cc`](https://basescan.org/address/0xE7bADd12bdf070e925A55A98c981f3aBAB4f20cc) (Base mainnet, chainId 8453)
- **Token:** NONCE (21M total · 18.9M reserved for mining)
- **Reward:** 100 NONCE per mint at era 0 (halves every 100k global mints)
- **Cap:** 10 mints per block, 1 mint per ~5 blocks target

## How PoW works

```
challenge = keccak256(abi.encode(chainid, contract, miner, epoch))
epoch     = block.number / 100
valid if  keccak256(abi.encode(challenge, nonce)) < currentDifficulty
```

Each miner gets their own challenge (not stealable from mempool). Difficulty auto-adjusts every 2016 mints.

## Quick start

### Requirements

- Rust toolchain (`rustc` >= 1.70 + `cargo`)
- Node.js 18+
- Funded wallet on Base mainnet (~0.001 ETH covers ~50+ tx)

### Install

```bash
git clone https://github.com/citojitu/nonce-miner
cd nonce-miner

# build Rust miner (~30s)
cargo build --release

# install Node deps
npm install

# configure
cp .env.example .env
# edit .env → paste your PRIVATE_KEY
```

### Run

```bash
node miner.js
```

The Node wrapper:
1. Fetches state (block, epoch, difficulty) from Base RPC
2. Spawns `target/release/nonce-miner` as subprocess with current challenge
3. Watches stdout for `FOUND <nonce>`
4. Submits `mine(nonce)` transaction
5. Repeats — auto-rotates on epoch flip (every 100 blocks ≈ 200s)

## Expected performance

| Hardware | Hashrate | Time per mint @ current diff* |
|---|---|---|
| AMD EPYC 4-core | ~5 MH/s | ~60 min |
| Intel i7-12700 | ~12 MH/s | ~25 min |
| Apple M2 8-core | ~20 MH/s | ~15 min |

*current diff ≈ 6.7e66, expects ~17 billion hashes per valid nonce. GPU recommended for serious mining — see [Nonce-miner-gpu](https://github.com/citojitu/Nonce-miner-gpu).

## Architecture

```
miner.js        ← Node wrapper (RPC, tx submission, epoch tracking)
  └─ spawns
target/release/nonce-miner   ← Rust CPU keccak loop (multi-threaded)
```

The Rust binary is **agnostic of the contract** — it just hashes `(challenge || nonce_be8)` and checks `< target`. Args:

```
nonce-miner <challenge_hex_32> <target_hex_32> <start_nonce> [threads]
```

It emits `FOUND <nonce>` on stdout when valid, `RATE <hashes_per_sec>` on stderr every ~2s.

## Security

- **NEVER commit `.env`** — `.gitignore` blocks it
- Private key stays local — only used to sign `mine()` transactions
- Use a dedicated miner wallet, not your main wallet
- Funded gas balance only — don't over-fund

## License

MIT. See [LICENSE](./LICENSE).

## Disclaimer

Not affiliated with the NONCE project. Use at your own risk — mining is competitive, contract bugs can exist, gas can spike. DYOR.
