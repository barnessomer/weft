// Preload (node --require): resolve *.elier.ai to a Cloudflare edge IP, like an /etc/hosts entry.
// Only for the local driver and agent hooks while public DNS for the Weft custom domains is
// missing or negatively cached; the edge routes by SNI/Host, so any Cloudflare anycast IP works.
// Enabled by demo/run-full.sh when WEFT_PIN_EDGE_IP is set. Never used by deployed Workers.
const dns = require("node:dns");
const ip = process.env.WEFT_PIN_EDGE_IP;
const suffix = process.env.WEFT_PIN_SUFFIX ?? ".elier.ai";
if (ip) {
  const orig = dns.lookup;
  dns.lookup = function lookup(host, options, cb) {
    if (typeof options === "function") (cb = options), (options = {});
    if (typeof host === "string" && host.endsWith(suffix)) {
      const o = typeof options === "number" ? { family: options } : options ?? {};
      if (o.all) return process.nextTick(cb, null, [{ address: ip, family: 4 }]);
      return process.nextTick(cb, null, ip, 4);
    }
    return orig.call(this, host, options, cb);
  };
}
