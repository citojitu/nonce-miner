// NONCE miner — search for u64 nonce such that
//   keccak256(challenge_32 || abi_encoded_u256(nonce)) < target
//
// Usage: nonce-miner <challenge_hex_32> <target_hex_32> <start_nonce> [threads]
// stdout (one line per find): "FOUND <nonce>"
// stderr (every ~2s):         "RATE <hashes_per_sec_aggregate>"
//
// Designed to be spawned by an outer Node/Python wrapper that handles RPC
// (read state, submit mine() tx).
use std::env;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tiny_keccak::{Hasher, Keccak};

#[inline(always)]
fn lt_be(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] != b[i] { return a[i] < b[i]; }
    }
    false
}

fn search(
    challenge: [u8; 32], target: [u8; 32],
    start: u64, stride: u64,
    found: Arc<AtomicBool>, result: Arc<AtomicU64>, counter: Arc<AtomicU64>,
) {
    let mut preimage = [0u8; 64];
    preimage[..32].copy_from_slice(&challenge);

    let mut nonce = start;
    let mut local = 0u64;
    loop {
        if local & 0xFFFF == 0 {
            if found.load(Ordering::Relaxed) { return; }
            counter.fetch_add(0x10000, Ordering::Relaxed);
        }
        // abi.encode(uint256(nonce)) = 24 zero bytes + 8 nonce BE
        preimage[56..64].copy_from_slice(&nonce.to_be_bytes());

        let mut hasher = Keccak::v256();
        hasher.update(&preimage);
        let mut out = [0u8; 32];
        hasher.finalize(&mut out);

        if lt_be(&out, &target) {
            if found.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                result.store(nonce, Ordering::SeqCst);
                println!("FOUND {}", nonce);
            }
            return;
        }

        nonce = nonce.wrapping_add(stride);
        local = local.wrapping_add(1);
    }
}

fn parse_hex32(s: &str) -> [u8; 32] {
    let s = s.trim_start_matches("0x");
    let bytes = hex::decode(s).expect("bad hex");
    assert_eq!(bytes.len(), 32, "expected 32 bytes");
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    out
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: nonce-miner <challenge_hex> <target_hex> <start_nonce> [threads]");
        std::process::exit(1);
    }
    let challenge = parse_hex32(&args[1]);
    let target    = parse_hex32(&args[2]);
    let start: u64 = args[3].parse().unwrap_or(0);
    let threads = if args.len() > 4 {
        let t: usize = args[4].parse().unwrap_or_else(|_| num_cpus());
        if t == 0 { num_cpus() } else { t }
    } else { num_cpus() };

    eprintln!("nonce-miner: threads={} start={}", threads, start);

    let found = Arc::new(AtomicBool::new(false));
    let result = Arc::new(AtomicU64::new(0));
    let counter = Arc::new(AtomicU64::new(0));

    let mut handles = vec![];
    for tid in 0..threads {
        let f = found.clone();
        let r = result.clone();
        let c = counter.clone();
        let h = thread::spawn(move || {
            search(challenge, target, start + tid as u64, threads as u64, f, r, c);
        });
        handles.push(h);
    }

    // hashrate reporter
    let f2 = found.clone();
    let c2 = counter.clone();
    let reporter = thread::spawn(move || {
        let mut last = 0u64;
        let mut t = Instant::now();
        while !f2.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_secs(2));
            let cur = c2.load(Ordering::Relaxed);
            let dt = t.elapsed().as_secs_f64();
            if dt > 0.0 {
                let rate = (cur - last) as f64 / dt;
                eprintln!("RATE {:.0}", rate);
            }
            last = cur;
            t = Instant::now();
        }
    });

    for h in handles { let _ = h.join(); }
    let _ = reporter.join();
}

fn num_cpus() -> usize {
    thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}
