import { describe, expect, it } from "vitest";
import worker from "./index";

describe("@weft/web", () => {
  it("exports a Worker handler", () => {
    expect(worker).toBeDefined();
  });
});
