import { describe, expect, it } from "vitest";
import worker from "./index";

describe("@weft/sandbox", () => {
  it("exports a Worker handler", () => {
    expect(worker).toBeDefined();
  });
});
