#!/usr/bin/env node
// `npx weft-adapter-claude <command>` entry point: runs the bundled CLI, building it first
// when running from a source checkout.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, "dist", "weft-claude.mjs");
if (!existsSync(bundle)) execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "inherit" });
await import(pathToFileURL(bundle).href);
