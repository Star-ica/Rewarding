/**
 * Rewarding — Deployment Script
 * Usage: npx hardhat run scripts/deploy.js --network <network>
 *
 * Supported networks (configure in hardhat.config.js):
 *   botchain    — BOT Chain mainnet
 *   botchain_t  — BOT Chain testnet
 *   celo        — Celo mainnet
 *   localhost   — Hardhat local
 */

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ─── Network config ──────────────────────────────────────────────────────────
// BOT Chain USDT — verify before deployment
// Source: BOT Chain official documentation / block explorer
const KNOWN_TOKENS = {
    botchain: {
        USDT: "0x0000000000000000000000000000000000000000", // REPLACE with verified address
    },
    celo: {
        cUSD: "0x765DE816845861e75A25fCA122bb6898B8B1282a",
    },
};

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying Rewarding with account:", deployer.address);
    console.log("Network:", network.name);
    console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

    // ── Fee config ────────────────────────────────────────────────────────────
    const FEE_RECIPIENT = process.env.FEE_RECIPIENT || deployer.address;
    const FEE_BPS       = process.env.FEE_BPS       || "50"; // 0.5% default

    console.log(`\nFee recipient: ${FEE_RECIPIENT}`);
    console.log(`Platform fee:  ${FEE_BPS} bps (${Number(FEE_BPS) / 100}%)`);

    // ── Deploy ─────────────────────────────────────────────────────────────────
    const Rewarding = await ethers.getContractFactory("Rewarding");
    const rewarding = await Rewarding.deploy(FEE_RECIPIENT, FEE_BPS);
    await rewarding.waitForDeployment();

    const address = await rewarding.getAddress();
    console.log("\n✅ Rewarding deployed to:", address);

    // ── Verify on explorer (Etherscan-compatible) ─────────────────────────────
    if (network.name !== "localhost" && network.name !== "hardhat") {
        console.log("\nWaiting 5 blocks before verification...");
        await new Promise(r => setTimeout(r, 15_000));

        try {
            const { run } = require("hardhat");
            await run("verify:verify", {
                address,
                constructorArguments: [FEE_RECIPIENT, FEE_BPS],
            });
            console.log("✅ Contract verified");
        } catch (e) {
            console.log("Verification failed (may need manual verify):", e.message);
        }
    }

    // ── Save deployment artifact ──────────────────────────────────────────────
    const artifact = {
        network:     network.name,
        address,
        deployer:    deployer.address,
        feeRecipient: FEE_RECIPIENT,
        feeBps:      FEE_BPS,
        deployedAt:  new Date().toISOString(),
        knownTokens: KNOWN_TOKENS[network.name] || {},
    };

    const outPath = path.join(__dirname, `../deployments/${network.name}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log(`\nDeployment saved to: ${outPath}`);

    return artifact;
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
