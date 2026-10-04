import { describe, expect, it } from "vitest";

export const scaffoldPackage = "@weft/adapter-gemini";

describe("@weft/adapter-gemini", () => {
  it("compiles its scaffold", () => {
    expect(scaffoldPackage).toBe("@weft/adapter-gemini");
  });
});
