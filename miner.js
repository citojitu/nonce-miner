/**
 * NONCE miner wrapper — talks to Base mainnet, delegates keccak loop to
 * the Rust CPU binary (./target/release/nonce-miner).
 *
 * Backend protocol:
 *   stdout (per find):   "FOUND <decimal_nonce>"
 *   stderr (every ~2s):  "RATE <hashes_per_sec>"
 *
 * Backend args:  <challenge_hex_32> <target_hex_32> <start_nonce> [threads]
 */
"use strict";
require("dotenv").config({ path: __dirname + "/.env" });
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

const CONTRACT     = "0xE7bADd12bdf070e925A55A98c981f3aBAB4f20cc";
const CHAIN_ID     = 8453n;
const EPOCH_BLOCKS = 100n;
const RPC          = process.env.RPC_URL || "https://mainnet.base.org";
const PK           = process.env.PRIVATE_KEY;
const THREADS      = process.env.MINER_THREADS || "0"; // 0 = auto-detect

if (!PK) { console.error("PRIVATE_KEY env required (set in .env)"); process.exit(1); }
if (!/^0x[0-9a-fA-F]{64}$/.test(PK)) { console.error("PRIVATE_KEY format invalid"); process.exit(1); }

const BIN = path.join(__dirname, "target/release/nonce-miner");
if (!fs.existsSync(BIN)) {
  console.error(`miner binary not found: ${BIN}`);
  console.error(`build first: cargo build --release`);
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC);
const wallet   = new ethers.Wallet(PK, provider);
const contract = new ethers.Contract(CONTRACT, [
  "function mine(uint256 nonce) external",
  "function currentDifficulty() view returns (uint256)",
  "function totalMints() view returns (uint256)",
  "function genesisComplete() view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
], wallet);

function makeChallenge(miner, epoch) {
  const enc = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256","address","address","uint256"],
    [CHAIN_ID, CONTRACT, miner, epoch]
  );
  return ethers.keccak256(enc);
}

let currentChild = null;
let currentEpoch = null;
let busy = false;

function killChild() {
  if (currentChild) {
    try { currentChild.kill("SIGKILL"); } catch {}
    currentChild = null;
  }
}

function spawnMiner(challenge, target) {
  killChild();
  const startNonce = Math.floor(Math.random() * 1e9);
  console.log(`[spawn] start=${startNonce} threads=${THREADS}`);
  const c = spawn(BIN, [challenge, target, startNonce.toString(), THREADS]);

  let buf = "";
  c.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line.startsWith("FOUND ")) onFound(line.slice(6).trim());
    }
  });
  c.stderr.on("data", (chunk) => {
    const s = chunk.toString().trim();
    if (s.startsWith("RATE ")) {
      const rate = parseInt(s.slice(5), 10);
      console.log(`[hashrate] ${(rate / 1_000_000).toFixed(2)} MH/s`);
    } else if (s) {
      console.log(`[backend] ${s}`);
    }
  });
  c.on("exit", () => { if (currentChild === c) currentChild = null; });
  currentChild = c;
}

async function onFound(nonce) {
  if (busy) return;
  busy = true;
  console.log(`[hit] nonce=${nonce}`);
  killChild();
  try {
    const fee = await provider.getFeeData();
    const tip = ethers.parseUnits("0.01", "gwei");
    const maxFee = (fee.gasPrice || tip * 10n) * 12n / 10n + tip;
    const tx = await contract.mine(BigInt(nonce), {
      maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, gasLimit: 250000n,
    });
    console.log(`[tx] ${tx.hash}`);
    const r = await tx.wait();
    if (r.status === 1) {
      const bal = await contract.balanceOf(wallet.address);
      console.log(`[✅ mined] block ${r.blockNumber}, fee ${ethers.formatEther(r.gasUsed * r.gasPrice)} ETH`);
      console.log(`[balance] ${ethers.formatUnits(bal, 18)} NONCE`);
    } else {
      console.log(`[❌ revert] block ${r.blockNumber}`);
    }
  } catch (e) {
    console.log(`[submit err]`, e.shortMessage || e.message);
  }
  busy = false;
  await refresh();
}

async function refresh() {
  try {
    const block = await provider.getBlockNumber();
    const epoch = BigInt(block) / EPOCH_BLOCKS;
    const difficulty = await contract.currentDifficulty();
    const totalMints = await contract.totalMints();
    const target = "0x" + difficulty.toString(16).padStart(64, "0");
    const challenge = makeChallenge(wallet.address, epoch);

    if (epoch !== currentEpoch) {
      console.log(`[epoch ${epoch}] block ${block}, diff ${difficulty}, totalMints ${totalMints}`);
      console.log(`  challenge ${challenge}`);
      console.log(`  target    ${target}`);
      currentEpoch = epoch;
      spawnMiner(challenge, target);
    } else if (!currentChild && !busy) {
      spawnMiner(challenge, target);
    }
  } catch (e) {
    console.log(`[refresh err]`, e.message);
  }
}

(async () => {
  console.log(`miner: ${wallet.address}`);
  const bal = await provider.getBalance(wallet.address);
  console.log(`gas balance: ${ethers.formatEther(bal)} ETH`);
  if (bal < ethers.parseEther("0.0001")) {
    console.warn("⚠️  low ETH for gas — fund wallet on Base mainnet before mining");
  }
  await refresh();
  setInterval(refresh, 30_000);
})();

process.on("SIGINT", () => { killChild(); process.exit(0); });
process.on("SIGTERM", () => { killChild(); process.exit(0); });
