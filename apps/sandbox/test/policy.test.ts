import { describe, expect, it } from "vitest";
import { decide, type OutboundEnv, type OutboundProps } from "../src/policy";
import { splitRequest, validateRunRequest, type RunRequest } from "../src/spec";

const props: OutboundProps = {
  run: "run-1",
  repo: "weft-demo",
  task: "T-1",
  change: "I" + "ab".repeat(20),
  agent: "claude-a",
  git: { host: "2d65.artifacts.cloudflare.net", path_prefix: "/git/weft-preview/weft-weft-demo-t-1-1.git", token: "art_v1_" + "1".repeat(40) },
  weft: { origin: "https://weft-gateway-preview.x.workers.dev", token: "wcp_agent" },
  allow_hosts: ["registry.npmjs.org"],
};
const env: OutboundEnv = { AI_GATEWAY_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "weft", ANTHROPIC_API_KEY: "sk-ant-real" };
const u = (s: string) => new URL(s);

describe("outbound policy", () => {
  it("adds the provider key and the run's metadata on AI Gateway calls (and drops the placeholder)", () => {
    const d = decide("POST", u("https://gateway.ai.cloudflare.com/v1/acct/weft/anthropic/v1/messages"), props, env);
    expect(d).toMatchObject({ action: "forward", kind: "aig", set: { "x-api-key": "sk-ant-real" } });
    if (d.action !== "forward") throw new Error();
    expect(d.drop).toContain("x-api-key");
    expect(JSON.parse(d.set["cf-aig-metadata"]!)).toEqual({ run: "run-1", task: "T-1", change: props.change, agent: "claude-a", repo: "weft-demo" });
    expect(d.set["cf-aig-authorization"]).toBeUndefined();
  });

  it("uses the gateway token for authenticated gateways / BYOK", () => {
    const d = decide("POST", u("https://gateway.ai.cloudflare.com/v1/acct/weft/openai/responses"), props, { ...env, AI_GATEWAY_TOKEN: "aig-tok", OPENAI_API_KEY: undefined });
    expect(d).toMatchObject({ action: "forward", set: { "cf-aig-authorization": "Bearer aig-tok" } });
    if (d.action !== "forward") throw new Error();
    expect(d.set.authorization).toBeUndefined();
    expect(d.drop).toContain("authorization");
  });

  it("serves workers-ai through the AI binding when no gateway token is configured", () => {
    const withAi = { ...env, AI: { run: async () => ({}) } };
    expect(decide("POST", u("https://gateway.ai.cloudflare.com/v1/acct/weft/workers-ai/v1/chat/completions"), props, withAi)).toMatchObject({ action: "ai-binding", compat: true, model: null, gateway: "weft", metadata: { run: "run-1" } });
    expect(decide("POST", u("https://gateway.ai.cloudflare.com/v1/acct/weft/workers-ai/@cf/meta/llama-3.1-8b-instruct"), props, withAi)).toMatchObject({ action: "ai-binding", compat: false, model: "@cf/meta/llama-3.1-8b-instruct" });
  });

  it("refuses other gateways, accounts and plain HTTP", () => {
    expect(decide("POST", u("https://gateway.ai.cloudflare.com/v1/acct/other/anthropic/v1/messages"), props, env)).toMatchObject({ action: "deny", status: 403 });
    expect(decide("POST", u("https://gateway.ai.cloudflare.com/v1/evil/weft/anthropic"), props, env)).toMatchObject({ action: "deny" });
    expect(decide("GET", u("http://gateway.ai.cloudflare.com/v1/acct/weft/x"), props, env)).toMatchObject({ action: "deny", status: 403 });
  });

  it("authenticates git only for this run's fork", () => {
    expect(decide("GET", u("https://2d65.artifacts.cloudflare.net/git/weft-preview/weft-weft-demo-t-1-1.git/info/refs?service=git-upload-pack"), props, env)).toMatchObject({ action: "forward", kind: "git", set: { authorization: `Bearer ${props.git!.token}` } });
    expect(decide("POST", u("https://2d65.artifacts.cloudflare.net/git/weft-preview/weft-weft-demo-t-1-1.git/git-receive-pack"), props, env)).toMatchObject({ action: "forward", kind: "git" });
    expect(decide("GET", u("https://2d65.artifacts.cloudflare.net/git/weft-preview/weft-demo.git/info/refs"), props, env)).toMatchObject({ action: "deny", status: 403 });
    expect(decide("GET", u("https://2d65.artifacts.cloudflare.net/git/weft-preview/weft-weft-demo-t-1-1.git-evil/info/refs"), props, env)).toMatchObject({ action: "deny" });
  });

  it("swaps the adapter's placeholder for the agent token on the coordinator", () => {
    expect(decide("POST", u("https://weft-gateway-preview.x.workers.dev/v1/repos/weft-demo/sessions"), props, env)).toMatchObject({ action: "forward", kind: "weft", set: { authorization: "Bearer wcp_agent" } });
  });

  it("allow_hosts are read-only, everything else is refused", () => {
    expect(decide("GET", u("https://registry.npmjs.org/typescript"), props, env)).toMatchObject({ action: "forward", kind: "allow" });
    expect(decide("PUT", u("https://registry.npmjs.org/typescript"), props, env)).toMatchObject({ action: "deny", status: 405 });
    expect(decide("GET", u("https://example.com/"), props, env)).toMatchObject({ action: "deny", status: 403 });
    expect(decide("GET", u("https://api.anthropic.com/v1/messages"), props, env)).toMatchObject({ action: "deny", status: 403 });
  });
});

describe("run request", () => {
  const ok: RunRequest = { repo: "weft-demo", task: "T-1", change: "I" + "0".repeat(40), agent: "a", harness: "claude-code", prompt: "do it", fork: { remote: "https://h/git/ns/r.git", token: "art_v1_x" }, weft: { url: "https://w", token: "wcp" } };
  it("validates", () => {
    expect(validateRunRequest(ok)).toEqual([]);
    expect(validateRunRequest({ ...ok, fork: undefined })).toContain("fork required");
    expect(validateRunRequest({ ...ok, harness: "script" as const })).toContain("script harness needs command: string[]");
    expect(validateRunRequest({ ...ok, run: "Bad_Id" })).toContain("run must match [a-z0-9-]{1,63}");
    expect(validateRunRequest({ ...ok, fork: { remote: "ssh://x" } })).toEqual(["fork.remote must be an https:// (or file:// in tests) git URL"]);
    expect(validateRunRequest({ ...ok, prompt: "x".repeat(130 * 1024) })).toContain("prompt + agents_md must be < 120 KiB");
    expect(validateRunRequest({ ...ok, instance: "huge" })[0]).toMatch(/^instance must be one of/);
  });
  it("splits secrets out of the container spec", () => {
    const { spec, secrets } = splitRequest(ok, "run-1", "https://gateway.ai.cloudflare.com/v1/a/weft");
    expect(secrets).toEqual({ git_token: "art_v1_x", weft_token: "wcp" });
    expect(JSON.stringify(spec)).not.toContain("art_v1_x");
    expect(JSON.stringify(spec)).not.toContain('"wcp"');
    expect(spec).toMatchObject({ run: "run-1", fork: { remote: "https://h/git/ns/r.git" }, weft: { url: "https://w" }, ai_gateway: { base_url: "https://gateway.ai.cloudflare.com/v1/a/weft" } });
  });
});
