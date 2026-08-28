import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "upstream/pi-version.json"), "utf8"));

let actualCommit;
try {
  const piPath = resolve(root, "upstream/pi");
  const safePiPath = piPath.replaceAll("\\", "/");
  actualCommit = execFileSync("git", ["-c", `safe.directory=${safePiPath}`, "-C", piPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
} catch {
  console.error("Pi submodule 未初始化。运行：git submodule update --init --recursive");
  process.exit(1);
}

if (manifest.commit !== actualCommit) {
  console.error(`Pi pin 不一致：manifest=${manifest.commit} actual=${actualCommit}`);
  process.exit(1);
}

console.log(`Pi pin verified: ${manifest.tag} @ ${actualCommit.slice(0, 12)}`);
