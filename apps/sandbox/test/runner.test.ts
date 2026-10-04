// RunController (the DO's logic) driving a local child_process container that runs the real
// image/agent-run.mjs: cold vs warm start timings, R2 log chunks, completion, secrets hygiene.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RunController, type RunStatus } from "../src/runner";
import type { RunRequest } from "../src/spec";
import { LocalContainer, MemoryKV, MemorySink, commitMessage, forkHead, trunkAndFork } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_RUN = join(here, "..", "image", "agent-run.mjs");
const CHANGE = "I" + "cd".repeat(20);
const GIT_TOKEN = "art_v1_" + "9".repeat(40);
const WEFT_TOKEN = "wcp_secret_agent_token_abcdef";

async function controller(container = new LocalContainer()) {
  const kv = new MemoryKV();
  const sink = new MemorySink();
  const work = await mkdtemp(join(tmpdir(), "weft-ctr-"));
  const prepared: unknown[] = [];
  const reports: Array<{ url: string; status: RunStatus }> = [];
  const c = new RunController({
    container,
    kv,
    logs: sink,
    workRoot: work,
    agentRun: AGENT_RUN,
    node: process.execPath,
    aiGatewayBase: "https://gateway.ai.cloudflare.com/v1/acct/weft",
    prepare: async (p) => void prepared.push(p),
    report: async (url, status) => void reports.push({ url, status }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    maxChunkBytes: 64,
  });
  return { c, kv, sink, work, prepared, reports, container };
}

async function untilDone(c: RunController, max = 200): Promise<RunStatus> {
  for (let i = 0; i < max; i++) {
    const next = await c.tick();
    if (next === null) return (await c.status())!;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run did not finish");
}

describe("RunController", () => {
  it("rejects invalid requests without touching the container", async () => {
    const { c, container } = await controller();
    const r = await c.start({ repo: "r" } as RunRequest);
    expect(r).toMatchObject({ ok: false, code: 400 });
    expect(container.starts).toBe(0);
  });

  it("runs an agent end to end: cold start, logs to R2 in chunks, push, report, no secrets anywhere", async () => {
    const { base, fork, forkPath } = await trunkAndFork();
    const { c, sink, kv, prepared, reports, container } = await controller();
    const req: RunRequest = {
      run: "run-e2e",
      repo: "weft-demo",
      task: "T-1",
      change: CHANGE,
      agent: "script-a",
      harness: "script",
      command: ["sh", "-c", 'for i in 1 2 3; do echo "line $i of agent output"; done; printf "\\nexport const y = 2;\\n" >> greet.ts && git commit -qam "feat: y"'],
      fork: { remote: fork.remote, token: GIT_TOKEN },
      weft: { url: "https://weft-gateway-preview.example.workers.dev", token: WEFT_TOKEN },
      trailers: { "Change-Id": CHANGE },
      report: { url: "https://dispatcher.example/report" },
    };
    const s = await c.start(req);
    expect(s).toMatchObject({ ok: true, status: { run: "run-e2e", state: "starting", instance: "standard-1" } });
    expect(container.starts).toBe(0); // start() only validates + persists; boot() (DO alarm) starts the container
    const st0 = (await c.boot())!;
    expect(st0).toMatchObject({ state: "running", warm: false });
    expect(container.starts).toBe(1);
    expect(st0.timings.cold_start_ms).toBeGreaterThanOrEqual(0);
    expect(st0.timings.ready_at).toBeGreaterThanOrEqual(st0.timings.container_start_at!);
    // secrets reach the Outbound props (prepare), not the container spec
    expect(prepared[0]).toMatchObject({ secrets: { git_token: GIT_TOKEN, weft_token: WEFT_TOKEN } });
    expect(JSON.stringify((prepared[0] as { spec: unknown }).spec)).not.toContain(GIT_TOKEN);

    const done = await untilDone(c);
    expect(done.state).toBe("succeeded");
    expect(done.result).toMatchObject({ state: "succeeded", base, harness_exit: 0 });
    const head = (done.result as { head: string }).head;
    expect(await forkHead(forkPath)).toBe(head);
    expect(await commitMessage(forkPath, head)).toContain(`Change-Id: ${CHANGE}`);
    expect(done.timings).toMatchObject({ launched_at: expect.any(Number), finished_at: expect.any(Number), "agent_run.clone_ms": expect.any(Number), "agent_run.agent_ms": expect.any(Number) });

    // logs: numbered chunks (64-byte chunks force several), reassembled == the container's file
    expect(done.logs.chunks["agent.stdout.log"]).toBeGreaterThan(1);
    const stdout = sink.stream("runs/run-e2e/agent.stdout.log/");
    expect(stdout).toBe("line 1 of agent output\nline 2 of agent output\nline 3 of agent output\n");
    const steps = sink.stream("runs/run-e2e/runner.log/").trim().split("\n").map((l) => JSON.parse(l).step);
    expect(steps).toContain("pushed");
    expect(steps.at(-1)).toBe("finished");
    expect(JSON.parse(sink.objects.get("runs/run-e2e/status.json")!)).toMatchObject({ state: "succeeded" });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ url: "https://dispatcher.example/report", status: { state: "succeeded", change: CHANGE } });

    // secrets: never in R2, never in status
    expect(sink.all()).not.toContain(GIT_TOKEN);
    expect(sink.all()).not.toContain(WEFT_TOKEN);
    expect(JSON.stringify(done)).not.toContain(GIT_TOKEN);
    expect(JSON.stringify(done)).not.toContain(WEFT_TOKEN);
    // (they do persist in the DO's own storage, where the Outbound props are rebuilt from)
    expect([...kv.m.values()].join()).toContain(GIT_TOKEN);
  });

  it("second run in the same container is warm and refuses overlap while running", async () => {
    const container = new LocalContainer();
    const a = await controller(container);
    await a.c.start({ run: "run-1", repo: "r", task: "t", change: CHANGE, agent: "a", harness: "script", command: ["sleep", "1"] });
    await a.c.boot();
    const overlap = await a.c.start({ run: "run-1b", repo: "r", task: "t", change: CHANGE, agent: "a", harness: "script", command: ["true"] });
    expect(overlap).toMatchObject({ ok: false, code: 409 });
    expect((await untilDone(a.c)).state).toBe("succeeded");
    const b = await controller(container); // a new DO name would get a new container; same container = warm reuse
    await b.c.start({ run: "run-2", repo: "r", task: "t", change: CHANGE, agent: "a", harness: "script", command: ["true"] });
    const s = (await b.c.boot())!;
    expect(s).toMatchObject({ state: "running", warm: true });
    expect(s.timings.container_start_at).toBeUndefined();
    expect(s.timings.cold_start_ms).toBe(0);
    expect(container.starts).toBe(1);
    expect((await untilDone(b.c)).state).toBe("succeeded");
  });

  it("kill() stops a running agent and records it", async () => {
    const { c } = await controller();
    await c.start({ run: "run-k", repo: "r", task: "t", change: CHANGE, agent: "a", harness: "script", command: ["sh", "-c", "echo started; sleep 60"] });
    await c.boot();
    await new Promise((r) => setTimeout(r, 300));
    const k = await c.kill();
    expect(k?.state).toBe("killed");
    expect(await c.tick()).toBeNull();
  });

  it("marks the run lost when the container disappears", async () => {
    const container = new LocalContainer();
    const { c } = await controller(container);
    await c.start({ run: "run-l", repo: "r", task: "t", change: CHANGE, agent: "a", harness: "script", command: ["sleep", "5"] });
    await c.boot();
    await container.destroy();
    expect(await c.tick()).toBeNull();
    expect((await c.status())?.state).toBe("lost");
  });
});
