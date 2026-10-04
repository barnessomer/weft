import { describe, expect, it } from "vitest";

export const scaffoldPackage = "@weft/analyzer";

describe("@weft/analyzer", () => {
  it("compiles its scaffold", () => {
    expect(scaffoldPackage).toBe("@weft/analyzer");
  });
});
