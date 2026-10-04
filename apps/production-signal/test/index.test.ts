import { describe, expect, it } from "vitest";
import { errorsFromTail } from "../src/index";

describe("Tail normalization", () => {
  it("forwards exception stack traces but ignores response-only failures", async () => {
    const errors = await errorsFromTail([
      { eventTimestamp: 1_234, scriptName: "weft-demo", event: { exceptions: [{ name: "TypeError", message: "planted bug", stack: "TypeError: planted bug\n at handler" }], response: { status: 500 } } },
      { eventTimestamp: 1_235, scriptName: "weft-demo", event: { response: { status: 500 } } },
    ], "weft-demo");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ repo: "weft-demo", occurred_at: 1_234, script: "weft-demo", status: 500, stack: "TypeError: planted bug\n at handler" });
    expect(errors[0]!.event_id).toMatch(/^[a-f0-9]{64}$/);
  });
});
