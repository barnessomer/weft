import { describe, expect, it } from "vitest";

export const protocolScaffold = true;

describe("@weft/protocol", () => {
  it("compiles its scaffold", () => {
    expect(protocolScaffold).toBe(true);
  });
});
