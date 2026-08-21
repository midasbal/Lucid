// Minimal browser stand-in for node:fs. There is no filesystem in a browser,
// so this is not a polyfill in the usual sense, it is the correct behavior:
// no .env file can ever exist here. ec-core's loadEnv() calls existsSync()
// in a loop looking for a .env to read; making it always report "not found"
// lets loadEnv() fall through to its own dotenv() fallback call harmlessly.
// dotenv's config() wraps its own readFileSync call in try/catch internally
// (confirmed by reading node_modules/dotenv/lib/main.js before relying on
// this), so a throwing readFileSync here does not crash the app, dotenv
// just resolves with { error } set and loadEnv() does not check the result.

export function existsSync(): boolean {
  return false;
}

export function readFileSync(): never {
  throw new Error("no filesystem in the browser");
}

export default { existsSync, readFileSync };
