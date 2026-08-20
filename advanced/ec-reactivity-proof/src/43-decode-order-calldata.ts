import { decodeFunctionData } from "viem";

const ABI = [
  {
    type: "function",
    name: "placeBinaryOrder",
    stateMutability: "payable",
    inputs: [
      { name: "kind", type: "uint8" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "expireTimestampNs", type: "uint64" },
      { name: "orderType", type: "uint8" },
      { name: "selfMatchingOption", type: "uint8" },
      { name: "builder", type: "address" },
      { name: "builderFeeBpsTimes1k", type: "uint96" },
      { name: "userData", type: "uint64" },
    ],
    outputs: [
      { name: "success", type: "bool" },
      { name: "id", type: "uint128" },
    ],
  },
] as const;

const DATA = "0x718c2d4d00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000004e2000000000000000000000000000000000000000000000000000000000002eb50800000000000000000000000000000000000000000000000018cd4613cd618c0000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

const decoded = decodeFunctionData({ abi: ABI, data: DATA });
console.log(JSON.stringify(decoded, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
