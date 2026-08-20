import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export function compileContract(file: string, contractName: string): { abi: unknown[]; bytecode: `0x${string}` } {
  const solc = require("solc");
  const source = readFileSync(path.resolve(__dirname, "../contracts", file), "utf8");

  const input = {
    language: "Solidity",
    sources: { [file]: { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };

  // Resolve @somnia-chain/... imports straight from node_modules. Node's
  // require.resolve does exact-path lookup for a fully qualified subpath
  // like "@scope/pkg/contracts/Foo.sol", no package "exports" map needed.
  const findImports = (importPath: string) => {
    try {
      return { contents: readFileSync(require.resolve(importPath), "utf8") };
    } catch (e) {
      return { error: `import not found: ${importPath} (${(e as Error).message})` };
    }
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) {
    throw new Error("solc errors:\n" + errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  }
  const c = out.contracts[file][contractName];
  return { abi: c.abi, bytecode: ("0x" + c.evm.bytecode.object) as `0x${string}` };
}

export function compileHandler(): { abi: unknown[]; bytecode: `0x${string}` } {
  return compileContract("ReactiveHitHandler.sol", "ReactiveHitHandler");
}
