import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  retries: 0,
  // The trade and redeem specs both sign and send real transactions from
  // the same real funded testnet account (LUCID_TEST_PRIVATE_KEY). Found
  // live: running them with the default multi-worker parallelism raced
  // that one account's nonce sequence on live chain and both failed. There
  // is no live-chain-safe way to parallelize two flows sharing one
  // account's nonces without a coordination layer this project does not
  // have, so tests run one at a time, a real constraint of testing against
  // live state, not a workaround for a test bug.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5183",
    headless: true,
  },
  webServer: {
    command: "npx vite --port 5183 --strictPort",
    port: 5183,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
