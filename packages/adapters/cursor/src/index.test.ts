import { describe, expect, it } from "vitest";

export const scaffoldPackage = "@weft/adapter-cursor";

describe("@weft/adapter-cursor", () => {
  it("compiles its scaffold", () => {
    expect(scaffoldPackage).toBe("@weft/adapter-cursor");
  });
});
