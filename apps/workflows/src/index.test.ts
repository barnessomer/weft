import { describe, expect, it } from "vitest";
import worker from "./index";

describe("@weft/workflows", () => {
  it("exports a Worker handler", () => {
    expect(worker).toBeDefined();
  });
});
