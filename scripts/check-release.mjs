// Offline check of the assembled static site. Node 24 runs the shared TypeScript config directly.
// Usage: VITE_TOR_GATEWAYS='ip:port:certhash' node scripts/check-release.mjs [web/dist] [--json]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findNonPublicAddresses, releaseGateways } from "../frontend/build/gateways.ts";
import { MAINNET_CHECKPOINT, TOR_JS_DEMO_GATEWAY } from "../provider/src/config/mainnet.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const PAGES = ["index.html", "demo/index.html", "demo/example.html", "demo/network-check.html"];
const DAY = 86_400_000;
const CHECKPOINT_TIME = (1_606_824_023 + MAINNET_CHECKPOINT.epoch * 384) * 1000;
const SENSITIVE_FILE = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.dev-logs|secrets?|personal-token|settlement-key|id_rsa|hs_ed25519_secret_key)(?:\/|$)|\.(?:key|p12|pfx)$/i;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\\n\r]+[A-Za-z0-9+/=]{32,}/;
const ASSIGNED_SECRET = /["']?(?:private[_-]?key|settlement[_-]?key|personal[_-]?token|DERPC_PERSONAL_TOKEN)["']?\s*[:=]\s*["'](?:0x)?[a-f\d]{64}["']/i;

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}
function hasAttribute(tag, name) {
  return new RegExp(`\\s${name}(?:\\s|=|/?>)`, "i").test(tag);
}

/** Inspects build files/package metadata; never opens local .env/key files or makes network requests. */
export function checkRelease({ artifact = resolve(REPOSITORY, "web/dist"), root = REPOSITORY, configuredGateways, now = Date.now() } = {}) {
  artifact = resolve(artifact);
  const errors = [];
  const warnings = [];
  const fail = (check, message, path) => errors.push({ check, message, ...(path ? { path } : {}) });
  const checkpointAge = now - CHECKPOINT_TIME;
  if (!Number.isFinite(now) || checkpointAge < 0 || checkpointAge > 7 * DAY) {
    fail("checkpoint", "The pinned checkpoint is future-dated or older than the runtime's seven-day limit; refresh the trusted root and epoch together.");
  }
  let gateways = [];
  try { gateways = releaseGateways(configuredGateways); }
  catch { fail("gateways", "Set VITE_TOR_GATEWAYS in the shell to valid public KPS gateway addresses; use the same value for the build and this check."); }
  if (gateways.length && gateways.every(gateway => gateway === TOR_JS_DEMO_GATEWAY)) {
    warnings.push({ check: "demo-gateway", message: "Only the demonstration gateway is configured; reliable public gateway availability remains unverified." });
  }

  for (const path of ["README.md", "THREAT_MODEL.md", "AI_USAGE.md", "specs/OPERATIONS.md", "specs/SUBMISSION.md", "scripts/assemble-site.mjs"]) {
    if (!existsSync(resolve(root, path))) fail("release-files", "Required release instructions or assembly script are missing.", path);
  }
  for (const [path, names] of [["package.json", ["build:site", "typecheck"]], ["frontend/package.json", ["build", "test"]], ["web/package.json", ["build", "preview"]]]) {
    try {
      const { scripts } = JSON.parse(readFileSync(resolve(root, path), "utf8"));
      if (names.some(name => typeof scripts?.[name] !== "string" || !scripts[name].trim())) throw new Error();
    } catch { fail("commands", "Required build, test or preview command is missing; follow the repository run instructions.", path); }
  }
  const presentPages = PAGES.filter(path => existsSync(resolve(artifact, path)));
  for (const path of PAGES.filter(path => !presentPages.includes(path))) fail("pages", "Missing assembled page; run pnpm build:site with the release gateway setting.", path);
  let filesChecked = 0;
  const textFiles = new Map();
  // Refuse incomplete/non-site targets before scanning, so a typo cannot scan the source tree or home directory.
  if (presentPages.length === PAGES.length) {
    for (const entry of readdirSync(artifact, { recursive: true, withFileTypes: true })) {
      const path = relative(artifact, resolve(entry.parentPath, entry.name)).split(sep).join("/");
      if (entry.isSymbolicLink()) { fail("artifact-files", "Symlinks are not portable release assets.", path); continue; }
      if (!entry.isFile()) continue;
      filesChecked++;
      if (SENSITIVE_FILE.test(path)) { fail("artifact-files", "Sensitive local file or directory must not be included in the site.", path); continue; }
      const absolute = resolve(artifact, path);
      if (statSync(absolute).size > 32 * 1024 * 1024) { fail("artifact-files", "Asset exceeds the 32 MiB inspection limit.", path); continue; }
      const bytes = readFileSync(absolute);
      if (bytes.includes(0)) continue;
      const text = bytes.toString("utf8");
      textFiles.set(path, text);
      // The directory's operator guide intentionally tells node owners to bind APIs to loopback.
      // Exempt only those exact shell-copy lines in its assets, never demo transport artifacts or URLs.
      const addressText = path.startsWith("assets/") ? text
        .replace(/export DERPC_EXECUTION_URL=http:\/\/127\.0\.0\.1:8545(?=\\n|\r?\n|$)/g, "export DERPC_EXECUTION_URL=<local-node>")
        .replace(/export DERPC_BEACON_URL=http:\/\/127\.0\.0\.1:5052(?=\\n|\r?\n|$)/g, "export DERPC_BEACON_URL=<local-node>") : text;
      if (findNonPublicAddresses(addressText).length) fail("artifact-addresses", "Non-public address found in emitted text; rebuild with public release inputs.", path);
      if (PRIVATE_KEY.test(text) || ASSIGNED_SECRET.test(text)) fail("artifact-secrets", "An embedded private-key or token pattern needs removal and review.", path);
    }
    for (const path of PAGES) {
      const html = textFiles.get(path);
      if (!html) { fail("pages", "Page is not readable text.", path); continue; }
      for (const [tag] of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
        const target = attribute(tag, "src") ?? attribute(tag, "href");
        if (!target || target.startsWith("data:") || target.startsWith("#")) continue;
        if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) { fail("page-assets", "Page assets must use relative paths for subpath/IPFS hosting.", path); continue; }
        let local;
        try { local = resolve(artifact, dirname(path), decodeURIComponent(target.split(/[?#]/)[0])); }
        catch { fail("page-assets", "Invalid asset path.", path); continue; }
        const inside = relative(artifact, local);
        if (inside.startsWith(`..${sep}`) || inside === ".." || !existsSync(local)) fail("page-assets", "Referenced local asset is missing or outside the site.", path);
      }
    }
    const demoHtml = textFiles.get("demo/index.html") ?? "";
    const toggle = [...demoHtml.matchAll(/<input\b[^>]*>/gi)].map(([tag]) => tag).find(tag => attribute(tag, "id") === "enable-payments");
    const controls = [...demoHtml.matchAll(/<fieldset\b[^>]*>/gi)].map(([tag]) => tag).find(tag => attribute(tag, "id") === "payment-controls");
    if (!toggle || attribute(toggle, "type") !== "checkbox" || hasAttribute(toggle, "checked") || !controls || !hasAttribute(controls, "disabled")) {
      fail("payment-markup", "Built payment controls must start unchecked and disabled; runtime behavior still requires the existing UI tests.", "demo/index.html");
    }
    const demoScripts = [...textFiles].filter(([path]) => path.startsWith("demo/") && path.endsWith(".js")).map(([, text]) => text).join("\n");
    if (!demoScripts.includes(MAINNET_CHECKPOINT.root) || !new RegExp(`\\b${MAINNET_CHECKPOINT.epoch}\\b`).test(demoScripts)) {
      fail("checkpoint-artifact", "Built demo does not contain the current checkpoint root and epoch; rebuild from the current source.");
    }
    if (gateways.some(gateway => !demoScripts.includes(gateway))) fail("gateway-artifact", "Built demo does not contain the configured release gateways; rebuild with the same VITE_TOR_GATEWAYS value.");
  }
  return {
    ok: errors.length === 0, filesChecked,
    checkpoint: { epoch: MAINNET_CHECKPOINT.epoch, ageHours: Math.round(checkpointAge / 3_600_000 * 10) / 10, expiresAt: new Date(CHECKPOINT_TIME + 7 * DAY).toISOString() },
    gatewayCount: gateways.length, errors, warnings,
    limits: ["Offline checks do not establish gateway reachability, hosted browser behavior, committee-transition sync, or the quality of release documentation.", "Payment validation checks initial built HTML only; run the existing frontend UI tests for runtime behavior.", "Secret checks detect known literal patterns, not arbitrary secrets; matched values and local secret files are never printed."],
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const paths = args.filter(arg => !arg.startsWith("--"));
  if (paths.length > 1 || args.some(arg => arg.startsWith("--") && arg !== "--json")) {
    console.error("Usage: VITE_TOR_GATEWAYS='ip:port:certhash' node scripts/check-release.mjs [web/dist] [--json]");
    process.exitCode = 1;
  } else {
    const report = checkRelease({ artifact: paths[0] ? resolve(paths[0]) : undefined, configuredGateways: process.env.VITE_TOR_GATEWAYS });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${report.ok ? "PASS" : "FAIL"}: local release checks (${report.filesChecked} files; checkpoint ${report.checkpoint.ageHours} hours old).`);
      for (const [kind, findings] of [["ERROR", report.errors], ["NOTE", report.warnings]]) {
        for (const finding of findings) console.log(`${kind} ${finding.check}${finding.path ? ` (${finding.path})` : ""}: ${finding.message}`);
      }
      for (const limit of report.limits) console.log(`LIMIT: ${limit}`);
    }
    process.exitCode = report.ok ? 0 : 1;
  }
}
