import { describe, expect, it } from "vitest";

export const scaffoldPackage = "@weft/sequencer";

describe("@weft/sequencer", () => {
  it("compiles its scaffold", () => {
    expect(scaffoldPackage).toBe("@weft/sequencer");
  });
});
