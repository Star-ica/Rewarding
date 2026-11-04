require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PK = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "1".repeat(64); // placeholder

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: { chainId: 31337 },

    // BOT Chain mainnet — verify RPC URL with official docs
    botchain: {
      url: process.env.BOTCHAIN_RPC || "https://rpc.botchain.tg",
      chainId: 1991,
      accounts: [PK],
    },

    // BOT Chain testnet
    botchain_testnet: {
      url: process.env.BOTCHAIN_TESTNET_RPC || "https://testnet-rpc.botchain.tg",
      chainId: 1992,
      accounts: [PK],
    },

    // Celo mainnet
    celo: {
      url: "https://forno.celo.org",
      chainId: 42220,
      accounts: [PK],
    },

    // Celo Alfajores testnet
    alfajores: {
      url: "https://alfajores-forno.celo-testnet.org",
      chainId: 44787,
      accounts: [PK],
    },

    // Ethereum mainnet
    mainnet: {
      url: process.env.ETH_RPC || `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`,
      chainId: 1,
      accounts: [PK],
    },
  },
  etherscan: {
    apiKey: {
      mainnet:  process.env.ETHERSCAN_API_KEY || "",
      celo:     process.env.CELOSCAN_API_KEY  || "",
      botchain: process.env.BOTSCAN_API_KEY   || "",
    },
    customChains: [
      {
        network: "botchain",
        chainId: 1991,
        urls: {
          apiURL:    "https://bot-scan.io/api",
          browserURL: "https://bot-scan.io",
        },
      },
      {
        network: "celo",
        chainId: 42220,
        urls: {
          apiURL:    "https://api.celoscan.io/api",
          browserURL: "https://celoscan.io",
        },
      },
    ],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};
