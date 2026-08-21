// dotenv (a CJS dependency of ec-core) requires "crypto" at its own module
// top level, but only ever calls into it from decrypt(), the .env.vault
// feature this app never uses (confirmed by reading node_modules/dotenv/
// lib/main.js directly: crypto.createDecipheriv is the only call site, gated
// behind a DOTENV_KEY this app never sets). The real fix is not a working
// crypto polyfill, crypto-browserify's own dependency chain
// (create-hash -> ripemd160 -> an old readable-stream) crashed at module
// evaluation time with "Cannot read properties of undefined (reading
// 'slice')" well before any of our code ran, entirely dead weight for a
// call path we never take. This stub throws only if something actually
// calls into it, which nothing in this app's real usage does.

function unsupported(): never {
  throw new Error("crypto is not available in the browser build (unused: dotenv vault decryption only)");
}

export const createDecipheriv = unsupported;
export const createCipheriv = unsupported;
export const createHash = unsupported;
export const randomBytes = unsupported;
export default { createDecipheriv, createCipheriv, createHash, randomBytes };
