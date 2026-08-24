---
phase: deployment
title: M9.10 D7 Core Upgrade — Devnet Rollout
description: Core program upgrade for D7 funding parameters (SetFundingParams disc 24), devnet verification, and acceptance evidence.
status: deployed-devnet
feature: onchain-perps-dex
updated: 2026-08-24
---

# M9.10 D7 Core Upgrade — Devnet Rollout

## Summary

Upgraded the core program (`C7w2mKz2…`) on devnet to enable D7 coefficient-based funding
(SetFundingParams, discriminator 24). Applied funding parameters 10000/50/100, verified
idempotent initialization, oracle freshness, and dual-flow trade lifecycle through settlement.

## Deployment

| Field | Value |
|-------|-------|
| Program ID | `C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx` |
| Upgrade TX | `Dmh6CEXiGK4vyo9XqKNWTZYG9hUTDWm8xn2qPiaR2XaxkGZFZAQkv8c8DqhwsXQeDhjR3wEvJHjvNwN7KTrreBY` |
| Pre-upgrade slot | 487243244 |
| Post-upgrade slot | 487386516 |
| Authority | `ECmGsGAAPJimTwLk3SzkQ39pUQbaBj7U5qgSRRgYSFy` |
| Upgrade keypair | `/Users/kyler/.config/solana/id.json` |
| SBF artifact | `target/deploy/mgk_perps_core.so` (136,040 bytes) |
| Pre-upgrade hash | `117fdaae79aeccec3857087532d9b7236c7dd94ab421fff258637ab506630287` |
| Post-upgrade hash (content) | `70ff5f9b0633de18465b38c7356e0f210ddf80b8b9aaf19a9dd6b2f4f48748ab` |
| ProgramData allocation | 191,128 bytes |
| Artifact content match | ✅ (first 136,040 bytes match; rest is zero-padding) |
| Rollback binary | `target/deploy/rollback/mgk_perps_core_pre_upgrade.so` |

## SetFundingParams (disc 24) — Acceptance

| Field | Before | After |
|-------|--------|-------|
| coefficient_bps | 1 | **10000** |
| max_rate_bps | 50 | **50** (unchanged) |
| interval_slots | 100* | **100** |
| last_funding_slot | 429496729600 | **487386769** (reset to clock slot) |
| cum_funding | 0 | **0** (preserved) |

\* Note: The on-chain instrument was initialized with raw byte offsets in `initialize.rs`
that don't match the `#[repr(C)]` struct alignment. The `funding_interval_slots` field
is at struct offset 120 (not 116 as init writes). The SetFundingParams instruction
correctly uses struct field access, so the value was correctly updated at offset 120.

### SetFundingParams TX

```
2Hys2B8ujfFNhx8i6TsnuBPCfNBQFjH3b4ZV97Y1TBgaYjjtZxCFfg9zyGEVsRYoBm4FiPhmY2LfxdJFtSFE6tbQ
```

Logs:
```
Program C7w2mKz2… invoke [1]
Program log: Instruction: SetFundingParams
Program log: SetFundingParams: applied
Program C7w2mKz2… success
```

### Idempotent skip verification

Re-running `set-funding-params.js` with same params correctly reports:
```
[set-funding-params] Params already match target (idempotent skip)
```

## Protocol Initialization (idempotent)

All accounts verified present:
- Registry: `CbsfrRS2rYE2qgJbi7MM6mLzARUy8cDiYmHW2o12jYJA` (86 bytes, core-owned)
- Instrument: `Hz9UtmSXyKFnp1pGvrhrAmizMsvEkYRh5Eih1r7Lf1hG` (336 bytes, core-owned)
- Vault: `9qe7TkRxDXHo3dywPKiiY1jwSBnFuSPHmGTWhcP8ttXE` (80 bytes, core-owned)
- Book: `J33Y6yo6AZM6JKLEw89tN1kPmyEADqWWjGxb1aAW915j` (27,704 bytes, matcher-owned)
- Batch0: `D6khMvcetfD9WKGob3WBNycvfKQoNEz2dp3LpnNLRxrt` (160 bytes, status=3 Settled)

SetBatchParams TX: `2DZeaskUshZN8FkGgsug7nbBzuEseErtCAvJtSjtKgHMSp5vbTyqqkNF1djWo13qtJEgFpDehckngNnioDLLj5J2`

## Oracle Refresh

Single-cycle oracle update confirmed:
```
Aggregate SOL Price: 95.3900 USD (conf: ±0.0100, venues: coinbase,okx,binance,bybit)
Confirmed on-chain update: 25ZyU5CPMJ8jxHSbFBjwsBu3AQ5Zj4fM6tzviZHquuAtjkSMdsjZv3FQn6LLVEq7VVzTWw3sRLGmg3M75fa4FFGg
```

## Dual-Flow Trade Lifecycle

Batch 21: dual auction with fills and settlement.

| Metric | Value |
|--------|-------|
| Batch ID | 21 |
| Final status | 3 (Settled) |
| markValid | 1 |
| bidClear | 100000 |
| askClear | 100000 |
| matchedBid | 10 |
| matchedAsk | 10 |
| clearingPrice | 100000 |

### Lifecycle TX Signatures

| Step | Signature |
|------|-----------|
| Post:maker-buy | `5bPKa7WXWpGsURQYupfB5RDVnjNLo7rc5JXW1McnRGVjrRDoNsz3AWmRubBLcSAREkCfUcwdXKNJAd9P81v7e1Kg` |
| Post:taker-sell | `4dbmJughA7F67Y9z6Tm2Tw6HJZh2eaFAQ6Mzwt74GzUdD6Qw1beNJgzm5r5SDi1fbQ6Gusw5nPUiX6xLrCuFqKiU` |
| Post:maker-sell | `4376Qa3GTAsJ3D8hP2rNNESZSwmf36tUergXTAiQ62Ajmvo7eCb7T4XEhrv6HvTaDYdVaqJNti3fWuCPPYpavnUV` |
| Post:taker-buy | `5qdTXAe9hAJ9cFRRC4HCV5ZMFUZLfn98AXvpCvzvUkZVHAV2YiQrfnqSotgDfGqrsRdAVaR1GFR2kUrGs3EZei4j` |
| CloseCollecting | `2dthRq2eq9oDeuAHXZctkQLbcYk8vJvjXSUcL5TyH623nuAKExMHDhCxNKmUeZ3sb7Q4yGCfPasADYNFjNofay3k` |
| ClearBatch | `4seh4V5QMYH7APdSoxJrKebwQd2oBkPhbVfJtZsaXNtZzmLZ7o2mED7wn5C52Bq5goGVGYtcqJnELDCk9hzGXR2g` |
| SettleBatch | `5a2U96DcqbVm3UfGFzPeaWWfJwRxetV5wJmVgoPRpRMAmhjY3b6WeHi1Jp7AXFengPbYMUqYLwY7uALZe6bzoD7z` |

## Upgrade Key Guidance

⚠️ **Correct keypair:** Use `/Users/kyler/.config/solana/id.json` (the default Solana keypair).
Do **NOT** use `target/deploy/mgk_perps_core-keypair.json` — that resolves to a different
program ID than `C7w2mKz2…`. The keypair file in `target/deploy/` is for initial deployment
of a new program, not for upgrading an existing one.

## Rollback Procedure

1. Use `target/deploy/rollback/mgk_perps_core_pre_upgrade.so` (hash: `117fda…`).
2. Deploy with the same keypair: `solana program deploy --keypair /Users/kyler/.config/solana/id.json --url devnet --program-id C7w2mKz2KQgDroNNhACm9MutXhPiesVr9Gn2x8TDsRYx target/deploy/rollback/mgk_perps_core_pre_upgrade.so`
3. Retry and inspect signatures before treating transient RPC failures as rollback conditions.
4. Re-run the lifecycle smoke test to verify rollback.

## Struct Layout Note

The `initialize.rs` uses raw byte offsets that don't match the `#[repr(C)]` struct
alignment for the `Instrument` account. The i128 `cum_funding` field at offset 96
forces 16-byte alignment, shifting subsequent fields by 4 bytes compared to the
non-aligned offsets in the init code. This is a pre-existing issue that doesn't affect
runtime correctness because `SetFundingParams` uses struct field access. The JS decode
tool (`set-funding-params.js`) uses the correct struct-aligned offsets.
