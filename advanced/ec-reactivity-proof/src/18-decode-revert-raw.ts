import { decodeAbiParameters } from "viem";

const REVERT_DATA =
  "0x4f174b290000000000000000000000000000000000000000000000000000000000b032d000000000000000000000000000000000000000000000000000000000000003e8";

const argsData = ("0x" + REVERT_DATA.slice(10)) as `0x${string}`;
const decoded = decodeAbiParameters(
  [
    { name: "a", type: "uint256" },
    { name: "b", type: "uint256" },
  ],
  argsData,
);
console.log(decoded.map((x) => x.toString()));
