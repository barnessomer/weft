import { describe, expect, it } from "vitest";
import { redactTerms, scrubPublic } from "../src/scrub";

describe("scrubPublic", () => {
  it("maps <worker>.<sub>.workers.dev to <worker>.elier.ai and redacts the rest", () => {
    expect(scrubPublic('"https://weft-demo.sub-x.workers.dev/p/1"')).toBe('"https://weft-demo.elier.ai/p/1"');
    expect(scrubPublic("weft-gateway.sub-x.workers.dev repo")).toBe("weft-gateway.elier.ai repo");
    expect(scrubPublic("account sub-x.workers.dev")).toBe("account redacted.invalid");
    expect(scrubPublic("cut https://weft-web.sub-x...")).toBe("cut https://weft-web.[redacted]...");
    expect(scrubPublic("ok https://weft.elier...")).toBe("ok https://weft.elier...");
    expect(scrubPublic("plain text")).toBe("plain text");
  });
  it("replaces redact terms case-insensitively; ignores short terms", () => {
    expect(redactTerms(" ab, Acme-Co ,")).toEqual(["Acme-Co"]);
    expect(scrubPublic("by ACME-co and acme-co", ["Acme-Co"])).toBe("by redacted and redacted");
  });
});
