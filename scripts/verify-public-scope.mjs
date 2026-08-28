import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const privateDirectories = ["quizzes", "labs", "comparisons", "book/labs", "book/comparisons"];

for (const directory of privateDirectories) {
  if (existsSync(resolve(root, directory))) {
    throw new Error(`公共仓库包含私人目录：${directory}`);
  }
}

const forbiddenMarkers = [
  "quizzes/",
  "labs/",
  "comparisons/",
  "learningStatus:",
  "学习者答案",
  "掌握待验证",
  "等待复述与小测",
  "未解锁",
];
const textExtensions = new Set([".md", ".mts", ".ts", ".vue"]);
const scanRoots = ["README.md", "AGENTS.md", "book", "docs"];

function collect(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    collect(`${path}/${entry.name}`),
  );
}

for (const file of scanRoots.flatMap(collect)) {
  if (!textExtensions.has(extname(file))) continue;
  const content = readFileSync(file, "utf8");
  for (const marker of forbiddenMarkers) {
    if (content.includes(marker)) {
      throw new Error(`公共内容包含私人标记：${marker} (${file})`);
    }
  }
}

console.log("Public scope verified: no private learning artifacts");
