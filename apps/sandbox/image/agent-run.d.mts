// Types for the in-container orchestrator (plain ESM so the image needs no build step).
export declare const EXIT: { ok: number; spec: number; infra: number };
export declare function redact(s: string, extra?: string[]): string;
export declare function validateSpec(spec: Record<string, unknown>): string[];
export declare function buildPrompt(spec: Record<string, unknown>): string;
export declare function harnessCommand(spec: Record<string, unknown>, prompt: string): { argv: string[]; env: Record<string, string> };
export declare function parseOutcome(harness: string, stdout: string): Record<string, unknown> | undefined;
export declare function agentRun(runDir: string, opts?: { env?: Record<string, string | undefined> }): Promise<Record<string, any>>;
