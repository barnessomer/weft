import { describe, expect, it } from "vitest";

export const scaffoldPackage = "@weft/adapter-claude-code";

describe("@weft/adapter-claude-code", () => {
  it("compiles its scaffold", () => {
    expect(scaffoldPackage).toBe("@weft/adapter-claude-code");
  });
});
