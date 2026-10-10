// Local WCP coordinator for scripts/demo-stop-cap.sh: the protocol's ReferenceCoordinator over
// the spec §8.2/§9.3 HTTP routes, no auth. Bundled by the demo with esbuild; prints `listening <url>`.
//   DEMO_REPO (default demo), DEMO_CONFLICTS (hold | continue, default hold)
import { createServer } from "node:http";
import { ReferenceCoordinator, WcpProtocolError, type Hello, type Submit } from "@weft/protocol";

const repo = process.env.DEMO_REPO ?? "demo";
const conflicts = process.env.DEMO_CONFLICTS === "continue" ? "continue" : "hold";
const coord = new ReferenceCoordinator({ repo, conflicts });

const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : undefined;
  const send = (status: number, payload?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload === undefined ? "" : JSON.stringify(payload));
  };
  try {
    const path = (req.url ?? "").replace(/^\/v1/, "");
    let m: RegExpExecArray | null;
    if (req.method === "POST" && /^\/repos\/[^/]+\/sessions$/.test(path)) return send(201, coord.hello(json as Hello));
    if ((m = /^\/repos\/[^/]+\/sessions\/([^/]+)(\/\w+)?$/.exec(path))) {
      const [, sid, tail] = m;
      if (req.method === "POST" && tail === "/events") return send(200, coord.submit(sid!, json as Submit));
      if (req.method === "POST" && tail === "/inbox") return send(200, coord.drain(sid!, json?.ack));
      if (req.method === "POST" && tail === "/heartbeat") return send(200, coord.heartbeat(sid!));
      if (req.method === "POST" && tail === "/gate") return send(200, coord.gate(sid!, json));
      if (req.method === "DELETE" && !tail) {
        coord.bye(sid!, json?.reason);
        return send(204);
      }
    }
    if (req.method === "GET" && (m = /^\/repos\/[^/]+\/events\/(\d+)$/.exec(path))) return send(200, coord.event(Number(m[1])));
    return send(404, { type: "error", error: { code: "not_found", message: `no route ${req.method} ${path}` } });
  } catch (err) {
    if (err instanceof WcpProtocolError) return send(err.status, err.toJSON());
    return send(500, { type: "error", error: { code: "internal", message: String(err) } });
  }
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  console.log(`listening http://127.0.0.1:${port} repo=${repo} conflicts=${conflicts}`);
});
