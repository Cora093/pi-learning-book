import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const chapters = [
  ["01-agent-loop", "01"],
  ["02-tool-system", "02"],
  ["03-context-engineering", "03"],
  ["04-agent-runtime", "04"],
  ["05-application-engineering", "05"],
];

for (const [directory, number] of chapters) {
  const path = resolve(root, "book/chapters", directory, "index.md");
  const content = readFileSync(path, "utf8");
  if (!content.includes(`chapter: "${number}"`) || !content.includes("sourceStatus:")) {
    throw new Error(`章节元数据不完整：${path}`);
  }
}

const completedChapters = [
  {
    directory: "01-agent-loop",
    prefix: "AL",
    evidenceCount: 15,
    component: "<AgentLoopTrace />",
    artifacts: [
      "diagrams/01-agent-loop/run-lifecycle.mmd",
      "diagrams/01-agent-loop/tool-ordering.mmd",
    ],
  },
  {
    directory: "02-tool-system",
    prefix: "TS",
    evidenceCount: 16,
    component: "<ToolPipeline />",
    artifacts: [
      "diagrams/02-tool-system/contract-layers.mmd",
      "diagrams/02-tool-system/call-pipeline.mmd",
    ],
  },
  {
    directory: "03-context-engineering",
    prefix: "CE",
    evidenceCount: 16,
    component: "<ContextComposer />",
    artifacts: [
      "diagrams/03-context-engineering/request-assembly.mmd",
      "diagrams/03-context-engineering/compaction-boundary.mmd",
    ],
  },
  {
    directory: "04-agent-runtime",
    prefix: "AR",
    evidenceCount: 16,
    component: "<RuntimeLedger />",
    artifacts: [
      "diagrams/04-agent-runtime/runtime-state-boundaries.mmd",
      "diagrams/04-agent-runtime/session-tree.mmd",
    ],
  },
  {
    directory: "05-application-engineering",
    prefix: "AE",
    evidenceCount: 16,
    component: "<EvalTraceBench />",
    artifacts: [
      "diagrams/05-application-engineering/trace-to-evaluation.mmd",
      "diagrams/05-application-engineering/comparison-contract.mmd",
    ],
  },
];

let evidenceTotal = 0;

for (const chapter of completedChapters) {
  const chapterPath = resolve(root, "book/chapters", chapter.directory, "index.md");
  const chapterContent = readFileSync(chapterPath, "utf8");
  for (const marker of ["sourceStatus: verified", "contentStatus: complete", chapter.component]) {
    if (!chapterContent.includes(marker)) {
      throw new Error(`${chapter.directory} 缺少完成标记：${marker}`);
    }
  }

  const evidenceDirectory = resolve(root, "evidence", chapter.directory);
  const pattern = new RegExp(`^${chapter.prefix}-\\d{2}-.+\\.yaml$`);
  const evidenceFiles = readdirSync(evidenceDirectory).filter((file) => pattern.test(file)).sort();
  if (evidenceFiles.length !== chapter.evidenceCount) {
    throw new Error(
      `${chapter.directory} evidence map 数量不正确：expected=${chapter.evidenceCount} actual=${evidenceFiles.length}`,
    );
  }

  for (const [index, file] of evidenceFiles.entries()) {
    const evidence = readFileSync(resolve(evidenceDirectory, file), "utf8");
    const expectedId = `${chapter.prefix}-${String(index + 1).padStart(2, "0")}`;
    for (const marker of [
      `id: "${expectedId}"`,
      'tag: "v0.84.3"',
      'commit: "4e58f324fae8ebfa98a3d45181fb248072a2afac"',
      'status: "verified"',
    ]) {
      if (!evidence.includes(marker)) {
        throw new Error(`Evidence ${file} 缺少字段：${marker}`);
      }
    }
  }

  for (const artifact of [`evidence/${chapter.directory}/source-notes.md`, ...chapter.artifacts]) {
    readFileSync(resolve(root, artifact), "utf8");
  }
  evidenceTotal += evidenceFiles.length;
}

console.log(`Content verified: ${completedChapters.length}/${chapters.length} chapters, ${evidenceTotal} evidence maps`);
