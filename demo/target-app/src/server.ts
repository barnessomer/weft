import { createServer } from "node:http";
import { app } from "./api/routes.ts";

const port = Number(process.env.PORT ?? 3000);
createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = undefined;
  }
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]));
  const out = await app({ method: req.method ?? "GET", path: (req.url ?? "/").split("?")[0], headers, body });
  res.writeHead(out.status, out.headers ?? {});
  res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
}).listen(port, () => console.log(`target-app on http://localhost:${port}`));
