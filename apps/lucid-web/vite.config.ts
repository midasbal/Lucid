import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_VENUE_ID = "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";

// lucid-core pulls in ec-core, which was written for a Node CLI (dotenv,
// process.env, node:fs/node:path for locating a .env file). None of that
// belongs in a browser bundle, and there is no real filesystem to read a
// .env from here anyway, so it is not something to fully polyfill, only to
// make harmless. See APP-SLICE.md for the full account of what running
// lucid-core client-side actually required.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      // Covers what dotenv (a CJS dependency of ec-core) requires at its
      // own module top level: path, os, crypto map to their standard
      // browserify polyfills; Buffer and process become real globals.
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
      // fs excluded here on purpose: this plugin's own fs mock has no
      // existsSync, and no browser fs mock should be trusted with real
      // semantics anyway. resolve.alias below points both "fs" and
      // "node:fs" at our own stub instead, see src/shims/fs.ts.
      //
      // crypto excluded too: this plugin maps it to crypto-browserify,
      // whose own transitive chain (create-hash -> ripemd160 -> an old
      // readable-stream) crashed at module-evaluation time in dev with
      // "Cannot read properties of undefined (reading 'slice')", well
      // before any app code ran. dotenv only calls into crypto for its
      // .env.vault decryption feature, unreachable here (no DOTENV_KEY is
      // ever set), see src/shims/crypto.ts.
      exclude: ["fs", "crypto"],
    }),
  ],
  define: {
    // ec-core's loadConfig() reads process.env.VENUE_ID/NETWORK directly.
    // An earlier approach mutated a polyfilled process.env global from a
    // module imported first in main.tsx; that worked in dev but not in the
    // production build, where the venue-scoping error came back even
    // though the same code ran without error in dev, a real dev/prod
    // divergence in how the polyfilled process global behaves under
    // Rollup's production bundling versus Vite's dev server. define
    // sidesteps the question entirely: these two exact expressions are
    // replaced with literal values everywhere in the bundle, dev and prod
    // alike, at build time, no runtime global sharing involved.
    "process.env.VENUE_ID": JSON.stringify(process.env.VITE_VENUE_ID ?? DEFAULT_VENUE_ID),
    "process.env.NETWORK": JSON.stringify(process.env.VITE_NETWORK ?? "testnet"),
  },
  resolve: {
    alias: {
      // node:fs / fs: no browser polyfill provides real file I/O, and none
      // should, a .env file must never ship in a client bundle. Redirected
      // to a small stub that always reports "file not found", which is the
      // literal truth in a browser and lets ec-core's loadEnv() fall through
      // to its own no-op path instead of crashing on an unresolved import.
      "node:fs": path.resolve(__dirname, "src/shims/fs.ts"),
      fs: path.resolve(__dirname, "src/shims/fs.ts"),
      // crypto: see the nodePolyfills exclude note above and src/shims/crypto.ts.
      "node:crypto": path.resolve(__dirname, "src/shims/crypto.ts"),
      crypto: path.resolve(__dirname, "src/shims/crypto.ts"),
    },
  },
  optimizeDeps: {
    // wagmi's main entry and its "wagmi/connectors" subpath are separate
    // package exports. Left to its own discovery, Vite's dev-time scanner
    // found one before the other and pre-bundled them as two separate
    // optimization passes, which produced two live copies of wagmi's
    // internal context module, "useConfig must be used within
    // WagmiProvider" even though the provider was mounted correctly.
    // Listing both explicitly forces one pass, one shared instance.
    include: ["wagmi", "wagmi/connectors", "viem", "@tanstack/react-query"],
  },
});
