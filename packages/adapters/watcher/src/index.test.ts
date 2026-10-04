import { describe, expect, it } from "vitest";

export const scaffoldPackage = "@weft/adapter-watcher";

describe("@weft/adapter-watcher", () => {
  it("compiles its scaffold", () => {
    expect(scaffoldPackage).toBe("@weft/adapter-watcher");
  });
});
