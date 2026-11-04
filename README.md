# Rewarding — Token Distribution Platform

Multi-project ERC-20 / native token distribution with Merkle-proof whitelisting.

## Quick start

```bash
# 1. Install
npm install

# 2. Run tests
npm test

# 3. Start local node (separate terminal)
npm run node

# 4. Deploy to localhost
npm run deploy:local

# 5. Update CONTRACT_ADDRESS in frontend/index.html

# 6. Open frontend/index.html in your browser
```

## Deploy to BOT Chain testnet

```bash
# .env
DEPLOYER_PRIVATE_KEY=0xyourkey
FEE_RECIPIENT=0xYourFeeWallet
FEE_BPS=50

npm run deploy:bot-test
```

## File structure

```
rewarding/
├── contracts/
│   ├── Rewarding.sol        # Main contract (all logic)
│   └── MockERC20.sol        # Test token
├── scripts/
│   ├── deploy.js            # Deployment script
│   └── merkle.js            # Merkle proof utility (Node + browser)
├── tests/
│   └── Rewarding.test.js    # Hardhat test suite
├── frontend/
│   └── index.html           # Complete frontend (open in browser)
├── hardhat.config.js
├── package.json
├── README.md
└── Rewarding-Whitepaper.pdf # Technical whitepaper
```

## Whitelist CSV format

```
address,amount
0xWallet1,100
0xWallet2,250.5
0xWallet3,1000000000000000000  # raw wei also accepted
```

Amounts < 15 digits are treated as human-readable token units (multiplied by 10^decimals).
Amounts >= 15 digits are treated as raw wei.

## BOT Chain USDT

> ⚠ Verify the official USDT contract address on bot-scan.io before creating any campaign.
> Do not rely on any address in this codebase — it is intentionally left as a placeholder.

## Security notes

- Audit before mainnet deployment.
- The platform fee ceiling is 500 bps (5%) and cannot be raised by any admin.
- The Merkle root can only be updated before the first claim.
- Direct allocations can only be set before the first claim.
- refundUnclaimed is callable by anyone after expiry — it always pays the project owner.
# LendCircle
