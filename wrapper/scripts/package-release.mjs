// Native Docker release builder. Run on Linux x64 or ARM64; generated files stay in wrapper/out/.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, chmodSync, existsSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const options = {};
const args = process.argv.slice(2);
if (args.length !== 4) throw new Error("usage: --version 0.1.0 --arch x64|arm64");
for (let i = 0; i < args.length; i += 2) {
  if (!["--version", "--arch"].includes(args[i]) || Object.hasOwn(options, args[i])) throw new Error("invalid or duplicate option");
  options[args[i]] = args[i + 1];
}
const version = options["--version"], arch = options["--arch"];
if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version ?? "")) throw new Error("version must be three bounded semver numbers");
if (!["x64", "arm64"].includes(arch) || process.platform !== "linux" || process.arch !== arch) throw new Error("build and test natively on the requested Linux architecture");
const dockerArch = arch === "x64" ? "amd64" : "arm64";
const run = (binary, args, options = {}) => execFileSync(binary, args, { cwd: root, stdio: "inherit", timeout: 1_200_000, ...options });
const capture = (binary, args) => run(binary, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30_000 }).trim();
const sourceSha = capture("git", ["rev-parse", "HEAD"]);
const dirty = capture("git", ["status", "--porcelain"]) !== "";
if (process.env.GITHUB_ACTIONS === "true" && (dirty || sourceSha !== process.env.GITHUB_SHA)) throw new Error("CI release requires the exact clean workflow commit");
const daemon = capture("docker", ["info", "--format", "{{.OSType}}/{{.Architecture}}"]);
if (!["linux/" + dockerArch, "linux/" + (arch === "x64" ? "x86_64" : "aarch64")].includes(daemon)) throw new Error("Docker daemon architecture differs from the native build host");
const stem = `derpc-wrapper-${version}-linux-${arch}`;
const output = join(root, "wrapper/out/releases");
mkdirSync(output, { recursive: true });
const archive = join(output, `${stem}.tar.gz`);
if (existsSync(archive) || existsSync(archive + ".sha256")) throw new Error("release output already exists; preserve it or remove it explicitly before rebuilding");
const temporary = mkdtempSync(join(tmpdir(), "derpc-wrapper-release-"));
const directory = join(temporary, stem);
mkdirSync(directory);
const wrapperImage = `derpc-wrapper:${version}-linux-${arch}`;
const torImage = `derpc-wrapper-tor:${version}-linux-${arch}`;
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
try {
  const labels = ["--label", `org.opencontainers.image.revision=${sourceSha}`, "--label", "org.opencontainers.image.source=https://github.com/r0bops/DeRPC", "--label", `org.opencontainers.image.version=${version}`];
  run("docker", ["build", "--platform", `linux/${dockerArch}`, ...labels, "-t", wrapperImage, "-f", "wrapper/Dockerfile", "."]);
  run("docker", ["build", "--platform", `linux/${dockerArch}`, ...labels, "--build-arg", "TORRC=release/torrc", "-t", torImage, "-f", "wrapper/Dockerfile.tor", "wrapper"]);
  const inspect = image => {
    const [details] = JSON.parse(capture("docker", ["image", "inspect", image]));
    if (details.Os !== "linux" || details.Architecture !== dockerArch || !/^sha256:[a-f0-9]{64}$/.test(details.Id)) throw new Error("built image has the wrong platform or invalid ID");
    return { reference: image, id: details.Id, os: details.Os, architecture: details.Architecture };
  };
  const images = [inspect(wrapperImage), inspect(torImage)];
  run(process.execPath, ["wrapper/test/release-smoke.mjs", "--image", wrapperImage, "--tor-image", torImage, "--out", join(directory, "verification.json")]);
  const evidence = JSON.parse(readFileSync(join(directory, "verification.json"), "utf8"));
  if (evidence.ok !== true) throw new Error("offline container verification did not pass");
  for (const name of ["derpc-wrapper", "README.md", ".env.example"]) copyFileSync(join(root, "wrapper/release", name), join(directory, name));
  chmodSync(join(directory, "derpc-wrapper"), 0o755);
  copyFileSync(join(root, "LICENSE"), join(directory, "LICENSE"));
  const template = readFileSync(join(root, "wrapper/release/compose.yaml"), "utf8");
  writeFileSync(join(directory, "compose.yaml"), template.replace("DERPC_WRAPPER_IMAGE_PLACEHOLDER", wrapperImage).replace("DERPC_TOR_IMAGE_PLACEHOLDER", torImage));
  writeFileSync(join(directory, "ARCH"), arch + "\n");
  writeFileSync(join(directory, "images.lock"), images.map(image => `${image.reference} ${image.id}\n`).join(""));
  writeFileSync(join(directory, "build-info.json"), JSON.stringify({ schemaVersion: 1, kind: "derpc-wrapper-docker-release", version, platform: `linux/${dockerArch}`, sourceSha, uncommittedChanges: dirty, builtAt: new Date().toISOString(), images, freeOnly: true, containsPrivateKeys: false, verification: "offline-container-checks; live onion and operator enrollment remain separate" }, null, 2) + "\n");
  run("docker", ["image", "save", "--output", join(directory, "images.tar"), wrapperImage, torImage]);
  const files = ["ARCH", "LICENSE", "README.md", ".env.example", "build-info.json", "compose.yaml", "derpc-wrapper", "images.lock", "images.tar", "verification.json"];
  const checksums = [];
  for (const file of files.sort()) checksums.push(`${await digest(join(directory, file))}  ${file}\n`);
  writeFileSync(join(directory, "SHA256SUMS"), checksums.join(""));
  // Check the exact downloadable configuration without starting a stack or creating keys.
  run("docker", ["compose", "--project-name", "derpc-release-validation", "--env-file", join(directory, ".env.example"), "-f", join(directory, "compose.yaml"), "config", "--quiet"]);
  run("bash", [join(directory, "derpc-wrapper"), "help"]);
  const stagedArchive = join(temporary, `${stem}.tar.gz`);
  run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", stagedArchive, "-C", temporary, stem]);
  // Exercise the operator's actual downloaded archive without a host Node command.
  const installed = join(temporary, "install-check"), commands = join(temporary, "commands");
  mkdirSync(installed); mkdirSync(commands);
  for (const command of ["bash", "dirname", "sha256sum", "uname", "cat", "docker", "cp"]) symlinkSync(capture("which", [command]), join(commands, command));
  run("tar", ["-xzf", stagedArchive, "-C", installed]);
  const installedRoot = join(installed, stem), launcher = join(installedRoot, "derpc-wrapper");
  const operatorEnv = { ...process.env, PATH: commands, NODE_PATH: "" };
  run(join(commands, "bash"), [launcher, "install"], { env: operatorEnv });
  const envPath = join(installedRoot, ".env");
  if (readFileSync(envPath, "utf8") !== readFileSync(join(installedRoot, ".env.example"), "utf8") || (statSync(envPath).mode & 0o777) !== 0o600) throw new Error("operator installer did not create a private example configuration");
  const retained = readFileSync(envPath, "utf8") + "\n# existing operator configuration must survive reinstall\n";
  writeFileSync(envPath, retained);
  run(join(commands, "bash"), [launcher, "install"], { env: operatorEnv });
  if (readFileSync(envPath, "utf8") !== retained) throw new Error("operator installer replaced existing configuration");
  copyFileSync(stagedArchive, archive);
  writeFileSync(archive + ".sha256", `${await digest(archive)}  ${stem}.tar.gz\n`, { flag: "wx" });
  console.log(JSON.stringify({ ok: true, archive, version, platform: `linux/${dockerArch}`, sourceSha, uncommittedChanges: dirty, operatorInstallWithoutHostNode: true, existingConfigurationPreserved: true, images }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
