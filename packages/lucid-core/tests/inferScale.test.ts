import { describe, expect, it } from "vitest";
import { inferScale } from "../src/scale.js";

describe("inferScale", () => {
  it("infers a positive power of ten when the oracle value is already whole-dollar", () => {
    expect(inferScale(68688.54, 68716.52)).toBe(1);
  });

  it("infers a downscale when the oracle value carries extra decimal digits", () => {
    expect(inferScale(6868854, 68716.52)).toBe(0.01);
  });

  it("infers an upscale when the oracle value is far smaller than spot", () => {
    expect(inferScale(68.68854, 68716.52)).toBe(1000);
  });

  it("is exact for a reference price identical to the raw value", () => {
    expect(inferScale(2112.67, 2112.67)).toBe(1);
  });
});
