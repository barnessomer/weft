import { decide, type PolicyInput } from "./weft.policy";
export { decide } from "./weft.policy";

interface Env { POLICY_NAME?: string }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/evaluate") {
      return new Response("not found", { status: 404 });
    }
    let input: PolicyInput;
    try {
      input = await request.json<PolicyInput>();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (!input || typeof input.repo !== "string" || typeof input.task !== "string" || typeof input.change !== "string") {
      return Response.json({ error: "invalid_policy_input" }, { status: 400 });
    }
    return Response.json(decide(input, env.POLICY_NAME || input.repo));
  },
};
