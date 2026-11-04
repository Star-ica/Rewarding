/**
 * Rewarding Platform — Hardhat Test Suite
 * Run: npx hardhat test
 * Requires: npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox @openzeppelin/contracts merkletreejs keccak256
 */

const { expect }       = require("chai");
const { ethers }       = require("hardhat");
const { MerkleTree }   = require("merkletreejs");
const keccak256        = require("keccak256");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function leafFromEntry(address, amount) {
    return Buffer.from(
        ethers.solidityPackedKeccak256(["address","uint256"], [address, amount]).slice(2),
        "hex"
    );
}

function buildTree(entries) {
    const leaves = entries.map(e => leafFromEntry(e.address, e.amount));
    return new MerkleTree(leaves, keccak256, { sortPairs: true });
}

function getProof(tree, address, amount) {
    const leaf = leafFromEntry(address, amount);
    return tree.getHexProof(leaf);
}

// ─── Constants ────────────────────────────────────────────────────────────────
const FEE_BPS    = 100n;  // 1%
const ONE_DAY    = 86400n;
const MERKLE_MODE = 0n;
const DIRECT_MODE = 1n;

describe("Rewarding Platform", function () {
    let rewarding, token;
    let deployer, admin, projectOwner, alice, bob, carol, feeWallet;
    let projectId, campaignId;

    beforeEach(async () => {
        [deployer, admin, projectOwner, alice, bob, carol, feeWallet] = await ethers.getSigners();

        // Deploy mock ERC-20
        const Token = await ethers.getContractFactory("MockERC20");
        token = await Token.deploy("Test Token", "TST", ethers.parseEther("1000000"));
        await token.waitForDeployment();

        // Deploy Rewarding
        const Rewarding = await ethers.getContractFactory("Rewarding");
        rewarding = await Rewarding.deploy(feeWallet.address, FEE_BPS);
        await rewarding.waitForDeployment();

        // Fund project owner
        await token.transfer(projectOwner.address, ethers.parseEther("100000"));
    });

    // ── Project creation ──────────────────────────────────────────────────────
    describe("Project management", () => {
        it("creates a project and emits ProjectCreated", async () => {
            const tx = await rewarding.connect(projectOwner).createProject(
                "CoolDAO", "ipfs://logo", "A test DAO", "https://cooldao.xyz",
                "@cooldao", "discord.gg/cooldao"
            );
            const receipt = await tx.wait();
            const event = receipt.logs.find(l => l.fragment?.name === "ProjectCreated");
            projectId = event.args[0];
            expect(projectId).to.equal(1n);
            const p = await rewarding.getProject(projectId);
            expect(p.name).to.equal("CoolDAO");
            expect(p.owner).to.equal(projectOwner.address);
        });

        it("allows project owner to update project", async () => {
            await rewarding.connect(projectOwner).createProject(
                "Old Name","","","","","");
            await rewarding.connect(projectOwner).updateProject(
                1n,"New Name","","","","","");
            const p = await rewarding.getProject(1n);
            expect(p.name).to.equal("New Name");
        });

        it("reverts update from non-owner", async () => {
            await rewarding.connect(projectOwner).createProject("DAO","","","","","");
            await expect(
                rewarding.connect(alice).updateProject(1n,"Hack","","","","","")
            ).to.be.revertedWithCustomError(rewarding, "NotProjectOwner");
        });
    });

    // ── Merkle campaign ───────────────────────────────────────────────────────
    describe("Merkle campaign", () => {
        const ALLOCATION_PER_USER = ethers.parseEther("100");
        let tree, entries;

        beforeEach(async () => {
            await rewarding.connect(projectOwner).createProject("DAO","","","","","");
            projectId = 1n;

            entries = [
                { address: alice.address,  amount: ALLOCATION_PER_USER },
                { address: bob.address,    amount: ALLOCATION_PER_USER },
                { address: carol.address,  amount: ethers.parseEther("50") },
            ];
            tree = buildTree(entries);
            const root = tree.getHexRoot();

            const total = ethers.parseEther("250");
            const fee   = total * FEE_BPS / 10000n;
            await token.connect(projectOwner).approve(await rewarding.getAddress(), total + fee);

            const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
            const tx = await rewarding.connect(projectOwner).createCampaign(
                projectId, "Airdrop Season 1", "Early adopters airdrop",
                await token.getAddress(),
                total,
                now + 1n,
                now + ONE_DAY,
                root,
                MERKLE_MODE,
                false, // allowPartialClaim
                0n     // no vesting
            );
            const receipt = await tx.wait();
            const ev = receipt.logs.find(l => l.fragment?.name === "CampaignCreated");
            campaignId = ev.args[0];

            // advance time past start
            await ethers.provider.send("evm_increaseTime", [2]);
            await ethers.provider.send("evm_mine");
        });

        it("allows whitelisted user to claim via Merkle proof", async () => {
            const proof = getProof(tree, alice.address, ALLOCATION_PER_USER);
            const before = await token.balanceOf(alice.address);
            await rewarding.connect(alice).claimMerkle(campaignId, ALLOCATION_PER_USER, proof);
            const after = await token.balanceOf(alice.address);
            expect(after - before).to.equal(ALLOCATION_PER_USER);
        });

        it("prevents double claim", async () => {
            const proof = getProof(tree, alice.address, ALLOCATION_PER_USER);
            await rewarding.connect(alice).claimMerkle(campaignId, ALLOCATION_PER_USER, proof);
            await expect(
                rewarding.connect(alice).claimMerkle(campaignId, ALLOCATION_PER_USER, proof)
            ).to.be.revertedWithCustomError(rewarding, "AlreadyClaimed");
        });

        it("rejects invalid proof", async () => {
            const fakeProof = getProof(tree, bob.address, ALLOCATION_PER_USER);
            await expect(
                rewarding.connect(alice).claimMerkle(campaignId, ALLOCATION_PER_USER, fakeProof)
            ).to.be.revertedWithCustomError(rewarding, "InvalidProof");
        });

        it("rejects non-whitelisted user", async () => {
            const fakeEntries = [{ address: deployer.address, amount: ALLOCATION_PER_USER }];
            const fakeTree = buildTree(fakeEntries);
            const fakeProof = getProof(fakeTree, deployer.address, ALLOCATION_PER_USER);
            await expect(
                rewarding.connect(deployer).claimMerkle(campaignId, ALLOCATION_PER_USER, fakeProof)
            ).to.be.revertedWithCustomError(rewarding, "InvalidProof");
        });

        it("collects platform fee correctly", async () => {
            const feeBalance = await token.balanceOf(feeWallet.address);
            expect(feeBalance).to.equal(ethers.parseEther("2.5")); // 1% of 250
        });

        it("allows refund after expiry", async () => {
            await ethers.provider.send("evm_increaseTime", [Number(ONE_DAY) + 1]);
            await ethers.provider.send("evm_mine");
            const before = await token.balanceOf(projectOwner.address);
            await rewarding.refundUnclaimed(campaignId);
            const after = await token.balanceOf(projectOwner.address);
            expect(after).to.be.gt(before);
        });
    });

    // ── Direct campaign ───────────────────────────────────────────────────────
    describe("Direct whitelist campaign", () => {
        beforeEach(async () => {
            await rewarding.connect(projectOwner).createProject("ProjectX","","","","","");
            projectId = 1n;

            const total = ethers.parseEther("300");
            const fee   = total * FEE_BPS / 10000n;
            await token.connect(projectOwner).approve(await rewarding.getAddress(), total + fee);

            const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
            const tx = await rewarding.connect(projectOwner).createCampaign(
                projectId, "Direct Drop", "Small community drop",
                await token.getAddress(),
                total, now + 1n, now + ONE_DAY,
                ethers.ZeroHash, DIRECT_MODE, false, 0n
            );
            const receipt = await tx.wait();
            campaignId = receipt.logs.find(l => l.fragment?.name === "CampaignCreated").args[0];

            await rewarding.connect(projectOwner).setDirectAllocations(
                campaignId,
                [alice.address, bob.address],
                [ethers.parseEther("100"), ethers.parseEther("200")]
            );

            await ethers.provider.send("evm_increaseTime", [2]);
            await ethers.provider.send("evm_mine");
        });

        it("allows direct claim for whitelisted wallet", async () => {
            const before = await token.balanceOf(alice.address);
            await rewarding.connect(alice).claimDirect(campaignId);
            expect(await token.balanceOf(alice.address) - before).to.equal(ethers.parseEther("100"));
        });

        it("reverts for non-whitelisted wallet", async () => {
            await expect(
                rewarding.connect(carol).claimDirect(campaignId)
            ).to.be.revertedWithCustomError(rewarding, "NotWhitelisted");
        });
    });

    // ── Vesting campaign ──────────────────────────────────────────────────────
    describe("Linear vesting", () => {
        it("distributes proportional amount based on elapsed time", async () => {
            await rewarding.connect(projectOwner).createProject("VestDAO","","","","","");

            const entries = [{ address: alice.address, amount: ethers.parseEther("100") }];
            const tree = buildTree(entries);

            const total = ethers.parseEther("100");
            const fee   = total * FEE_BPS / 10000n;
            await token.connect(projectOwner).approve(await rewarding.getAddress(), total + fee);

            const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
            const vestDur = ONE_DAY; // vest over 1 day
            const tx = await rewarding.connect(projectOwner).createCampaign(
                1n, "Vested Drop", "", await token.getAddress(),
                total, now + 1n, now + ONE_DAY * 2n,
                tree.getHexRoot(), MERKLE_MODE, true, vestDur
            );
            const receipt = await tx.wait();
            const cId = receipt.logs.find(l => l.fragment?.name === "CampaignCreated").args[0];

            await ethers.provider.send("evm_increaseTime", [Number(ONE_DAY / 2n)]);
            await ethers.provider.send("evm_mine");

            const proof = getProof(tree, alice.address, ethers.parseEther("100"));
            const preview = await rewarding.previewClaimable(cId, ethers.parseEther("100"), alice.address);
            expect(preview).to.be.approximately(ethers.parseEther("50"), ethers.parseEther("1"));

            await rewarding.connect(alice).claimMerkle(cId, ethers.parseEther("100"), proof);
            const claimed = await token.balanceOf(alice.address);
            expect(claimed).to.be.approximately(ethers.parseEther("50"), ethers.parseEther("1"));
        });
    });

    // ── Admin controls ────────────────────────────────────────────────────────
    describe("Platform administration", () => {
        it("admin can update fee", async () => {
            await rewarding.setFee(200n);
            expect(await rewarding.platformFeeBps()).to.equal(200n);
        });

        it("reverts fee above 5%", async () => {
            await expect(rewarding.setFee(600n))
                .to.be.revertedWithCustomError(rewarding, "InvalidFee");
        });

        it("admin can pause platform", async () => {
            await rewarding.pausePlatform();
            expect(await rewarding.paused()).to.be.true;
        });

        it("admin can pause a specific campaign", async () => {
            await rewarding.connect(projectOwner).createProject("DAO","","","","","");
            const total = ethers.parseEther("100");
            await token.connect(projectOwner).approve(
                await rewarding.getAddress(), total + total * FEE_BPS / 10000n);
            const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
            await rewarding.connect(projectOwner).createCampaign(
                1n,"C","",await token.getAddress(),total,now+1n,now+ONE_DAY,
                ethers.ZeroHash,DIRECT_MODE,false,0n);
            await rewarding.adminPauseCampaign(1n);
            expect((await rewarding.getCampaign(1n)).status).to.equal(1n);
        });
    });
});

// ─── Standalone helper exports ─────────────────────────────────────────────
module.exports = { buildTree, getProof, leafFromEntry };
