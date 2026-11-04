/**
 * Rewarding — Merkle Proof Generator
 * Works in both browser (bundled) and Node.js.
 * Dependencies: merkletreejs, keccak256, ethers v6
 *
 * Browser usage: loaded via <script> tag in whitelist-manager.html
 * Node usage: const { buildTree, generateProofs } = require('./merkle.js')
 */

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        // Node / CommonJS
        const { MerkleTree } = require("merkletreejs");
        const keccak256 = require("keccak256");
        const { ethers } = require("ethers");
        module.exports = factory(MerkleTree, keccak256, ethers);
    } else {
        // Browser — dependencies loaded via CDN in HTML
        root.RewardingMerkle = factory(root.MerkleJS, root.keccak256, root.ethers);
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function (MerkleTree, keccak256, ethers) {

    /**
     * Build a leaf for one entry.
     * leaf = keccak256(abi.encodePacked(address, uint256))
     * This MUST match the Solidity: keccak256(abi.encodePacked(msg.sender, amount))
     *
     * @param {string} address  Checksummed or lowercase wallet address
     * @param {BigInt|string} amount  Token amount in wei (no decimals)
     * @returns {Buffer}
     */
    function buildLeaf(address, amount) {
        const packed = ethers.solidityPacked(
            ["address", "uint256"],
            [address, amount]
        );
        // keccak256 accepts hex strings with or without 0x in some versions
        const hash = ethers.keccak256(packed);
        return Buffer.from(hash.slice(2), "hex");
    }

    /**
     * Build a Merkle tree from an allowlist.
     *
     * @param {Array<{address: string, amount: BigInt|string}>} entries
     * @returns {MerkleTree}
     */
    function buildTree(entries) {
        if (!entries || entries.length === 0) {
            throw new Error("Entries array must not be empty");
        }
        const leaves = entries.map(e => buildLeaf(
            ethers.getAddress(e.address), // normalize to checksum
            BigInt(e.amount)
        ));
        return new MerkleTree(leaves, keccak256, {
            sortPairs: true,
            hashLeaves: false,
        });
    }

    /**
     * Get the Merkle root (hex string with 0x prefix).
     */
    function getRoot(tree) {
        return "0x" + tree.getRoot().toString("hex");
    }

    /**
     * Get a proof array for one entry.
     * @returns {string[]}  array of 0x-prefixed hex strings
     */
    function getProof(tree, address, amount) {
        const leaf = buildLeaf(
            ethers.getAddress(address),
            BigInt(amount)
        );
        return tree.getHexProof(leaf);
    }

    /**
     * Verify a proof locally (useful for validation before submission).
     */
    function verifyProof(root, address, amount, proof) {
        const leaf = buildLeaf(
            ethers.getAddress(address),
            BigInt(amount)
        );
        const tree = new MerkleTree([], keccak256, { sortPairs: true });
        return tree.verify(proof, leaf, root);
    }

    /**
     * Parse a CSV text into an entries array.
     * Expected CSV format:
     *   address,amount
     *   0xABCD...,1000000000000000000
     *
     * @param {string} csvText
     * @param {number} decimals  token decimals (default 18)
     * @returns {Array<{address: string, amount: string}>}
     */
    function parseCSV(csvText, decimals = 18) {
        const lines = csvText.trim().split("\n");
        const entries = [];
        const multiplier = BigInt(10) ** BigInt(decimals);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith("#")) continue;
            if (i === 0 && line.toLowerCase().includes("address")) continue; // header

            const parts = line.split(",").map(p => p.trim());
            if (parts.length < 2) {
                console.warn(`Skipping malformed line ${i + 1}: ${line}`);
                continue;
            }

            const addr = parts[0];
            const rawAmount = parts[1].replace(/"/g, "");

            // If the amount looks like a human number (e.g. "100"), multiply by decimals
            let amount;
            if (rawAmount.includes(".")) {
                // float → parse carefully
                const [whole, frac = ""] = rawAmount.split(".");
                const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
                amount = (BigInt(whole) * multiplier + BigInt(fracPadded)).toString();
            } else if (rawAmount.length < 15) {
                // assume human units
                amount = (BigInt(rawAmount) * multiplier).toString();
            } else {
                // assume already in wei
                amount = rawAmount;
            }

            try {
                entries.push({ address: ethers.getAddress(addr), amount });
            } catch {
                console.warn(`Invalid address at line ${i + 1}: ${addr}`);
            }
        }
        return entries;
    }

    /**
     * Generate full proof data for all entries.
     * Returns an object suitable for JSON download: { root, proofs: { [address]: { amount, proof } } }
     */
    function generateProofData(entries) {
        const tree = buildTree(entries);
        const root = getRoot(tree);
        const proofs = {};
        for (const entry of entries) {
            const addr = ethers.getAddress(entry.address);
            proofs[addr] = {
                amount: entry.amount.toString(),
                proof:  getProof(tree, addr, entry.amount),
            };
        }
        return { root, proofs, totalEntries: entries.length };
    }

    return {
        buildLeaf,
        buildTree,
        getRoot,
        getProof,
        verifyProof,
        parseCSV,
        generateProofData,
    };
}));
