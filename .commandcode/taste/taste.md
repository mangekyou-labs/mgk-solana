# testing
- For devnet protocol testing, write headless client test scripts (TypeScript/Node.js) using a funded wallet instead of Playwright browser tests. Confidence: 0.75
- For devnet Solana testing, use Backpack wallet over Phantom/Solflare since it doesn't block on preflight simulation. Confidence: 0.70

# solana-rpc
- When rate-limited on devnet RPC, store and rotate through multiple fallback RPC URLs (Alchemy, Infura, QuickNode, Helius). Confidence: 0.80

# solana
- Phantom and Solflare wallet preflight simulation cannot be bypassed (can't change RPC URL or skip preflight). Confidence: 0.85
