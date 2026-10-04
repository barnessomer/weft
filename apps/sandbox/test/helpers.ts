// Test doubles: a local child_process "container" with Cloudflare exec semantics, in-memory
// DO storage and R2, and a trunk + fork on the git-backed Artifacts fake.
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitArtifacts, git } from "@weft/artifacts/git";
import type { ContainerLike, ExecOptionsLike, ExecProcessLike, KV, LogSink } from "../src/runner";

export class LocalContainer implements ContainerLike {
  running = false;
  starts = 0;
  readonly execs: string[][] = [];
  constructor(private readonly pathEnv = process.env.PATH ?? "/usr/bin:/bin") {}
  start(): void {
    if (this.running) throw new Error("already running");
    this.running = true;
    this.starts++;
  }
  async destroy() {
    this.running = false;
  }
  async setInactivityTimeout() {}
  async exec(cmd: string[], o: ExecOptionsLike = {}): Promise<ExecProcessLike> {
    if (!this.running) throw new Error("container not running");
    this.execs.push(cmd);
    // Cloudflare semantics: the process gets only `env` plus PATH.
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: o.cwd,
      env: { PATH: this.pathEnv, ...(o.env ?? {}) },
      stdio: [o.stdin ? "pipe" : "ignore", o.stdout === "ignore" ? "ignore" : "pipe", o.stderr === "ignore" ? "ignore" : "pipe"],
    });
    if (o.stdin && o.stdin !== "pipe") {
      const reader = o.stdin.getReader();
      void (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          child.stdin!.write(value);
        }
        child.stdin!.end();
      })();
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    const exitCode = new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(127));
    });
    const buf = (b: Buffer[]) => {
      const c = Buffer.concat(b);
      return c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer;
    };
    return { exitCode, output: async () => ({ exitCode: await exitCode, stdout: buf(out), stderr: buf(err) }) };
  }
}

export class MemoryKV implements KV {
  readonly m = new Map<string, string>();
  async get<T>(k: string) {
    const v = this.m.get(k);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  async put<T>(k: string, v: T) {
    this.m.set(k, JSON.stringify(v));
  }
}

export class MemorySink implements LogSink {
  readonly objects = new Map<string, string>();
  async put(key: string, value: string | Uint8Array | ArrayBuffer) {
    this.objects.set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
  }
  stream(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => this.objects.get(k)!).join("");
  }
  all() {
    return [...this.objects.values()].join("\n");
  }
}

export async function trunkAndFork(files: Record<string, string> = { "greet.ts": "export function greet(n: string) {\n  return `hi ${n}`;\n}\n" }) {
  const arts = await GitArtifacts.create();
  await arts.create("weft-demo");
  const seed = await mkdtemp(join(tmpdir(), "weft-seed-"));
  await git(["init", "-q", "-b", "main", seed]);
  for (const [f, t] of Object.entries(files)) await writeFile(join(seed, f), t);
  await git(["add", "-A"], { cwd: seed });
  await git(["-c", "user.name=seed", "-c", "user.email=seed@x", "commit", "-qm", "init"], { cwd: seed });
  const base = (await git(["rev-parse", "HEAD"], { cwd: seed })).stdout.trim();
  const p = await git(["push", "-q", arts.remote("weft-demo"), "HEAD:refs/heads/main"], { cwd: seed });
  if (p.code !== 0) throw new Error(p.stderr);
  const fork = await (await arts.get("weft-demo")).fork("weft-weft-demo-t-1-1");
  return { arts, base, fork, forkPath: arts.path("weft-weft-demo-t-1-1") };
}

export async function forkHead(bare: string, ref = "refs/heads/main") {
  return (await git(["rev-parse", ref], { cwd: bare })).stdout.trim();
}

export async function commitMessage(bare: string, sha: string) {
  return (await git(["log", "-1", "--format=%B", sha], { cwd: bare })).stdout;
}

/** A fake harness binary dir: `claude` and `codex` that edit greet.ts, commit, and emit JSON events. */
export async function fakeHarnessBin(): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "weft-bin-"));
  await mkdir(bin, { recursive: true });
  const claude = `#!/bin/sh
printf '{"type":"system","subtype":"init","base":"%s","key":"%s","sandbox":"%s"}\\n' "$ANTHROPIC_BASE_URL" "$ANTHROPIC_API_KEY" "$IS_SANDBOX"
test -f .weft/task.md && printf '{"type":"system","subtype":"task_seen"}\\n'
printf '\\nexport const punct = "!";\\n' >> greet.ts
git add -A && git commit -qm "feat: punctuation" || exit 9
printf '{"type":"result","subtype":"success","is_error":false,"result":"done","num_turns":3,"total_cost_usd":0.01}\\n'
`;
  const codex = `#!/bin/sh
printf '{"type":"thread.started"}\\n'
printf '\\nexport const codex = 1;\\n' >> greet.ts
git add -A && git commit -qm "feat: codex" || exit 9
printf '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\\n{"type":"turn.completed","usage":{"input_tokens":5}}\\n'
`;
  await writeFile(join(bin, "claude"), claude);
  await writeFile(join(bin, "codex"), codex);
  await chmod(join(bin, "claude"), 0o755);
  await chmod(join(bin, "codex"), 0o755);
  return bin;
}
