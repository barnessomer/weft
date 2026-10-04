import { describe, expect, it } from "vitest";

export const scaffoldPackage = "@weft/adapter-codex";

describe("@weft/adapter-codex", () => {
  it("compiles its scaffold", () => {
    expect(scaffoldPackage).toBe("@weft/adapter-codex");
  });
});
