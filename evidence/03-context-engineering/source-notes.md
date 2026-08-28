# 第三章 Context Engineering 源码研究笔记

## 研究边界

- 上游仓库：`https://github.com/earendil-works/pi.git`
- 固定 tag：`v0.84.3`
- 固定 commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- 固定 commit 标题：`Release v0.84.3`
- 主范围：`packages/agent` 的模型上下文边界，以及 `packages/coding-agent` 的消息转换、系统提示、资源加载、扩展 hook、Session 重建、compaction 和 branch summary。
- 补充范围：`packages/ai` 的 `ToolResultMessage` 类型和代表性 provider 转换，仅用于确认 `content` / `details` 的边界。
- 排除：Pi `main`、通用 Agent/RAG 文章、未被固定源码证明的“最佳实践”。
- 核验方式：逐文件读取固定源码和测试源码。`upstream/pi/node_modules/vitest/dist/cli.js` 与 `packages/coding-agent/node_modules` 均不存在，因此没有运行上游 Vitest；下文的 `test` 只表示静态核对了测试及断言。

证据类型：

- `contract`：公开类型、接口或注释直接规定的行为。
- `source`：固定 commit 的实现直接表现出的行为。
- `test`：固定 commit 的测试源码和断言；本次未执行。
- `inference`：由多个已核验 symbol 组合得出的教学结论，不能冒充源码原词。

## 最小心智模型

每次请求模型时，Core 实际执行的是这条流水线：

```text
AgentContext.messages
  -> transformContext?           // AgentMessage[] -> AgentMessage[]
  -> convertToLlm                // AgentMessage[] -> Message[]
  -> Context { systemPrompt, messages, tools }
  -> streamFunction(model, Context, options)
```

Coding Agent 在低层边界外叠加资源加载、输入展开和扩展 hook：

```text
资源加载/重载
  -> SYSTEM.md / APPEND_SYSTEM.md
  -> AGENTS.md / CLAUDE.md 祖先链
  -> tools + snippets + guidelines + skills 元数据
  -> buildSystemPrompt

用户输入
  -> input hook
  -> skill command / prompt template 展开
  -> before_agent_start hook（一次 Run 起点）
  -> Agent.prompt

每次模型调用前
  -> context hook（接在 transformContext）
  -> convertToLlm

每个 Turn 结束后
  -> prepareNextTurn 刷新 systemPrompt / tools / model / thinkingLevel
```

这张组合图属于 `inference`，组成它的源码锚点见 E02、E03、E04、E08、E10、E12、E15、E16。

## 逐条原始证据

### E01 [contract] `AgentContext` 只有 system prompt、消息和工具三部分

**结论：** Core 传入循环的上下文快照是 `systemPrompt: string`、`messages: AgentMessage[]` 和可选 `tools: AgentTool[]`。它没有内建的 memory、retriever、vector store 或 RAG 字段。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentContext`
- 辅助行：411-419

**验证：** `contract`

### E02 [source + test] 每次模型调用都按固定顺序组装 `systemPrompt/messages/tools`

**结论：** `streamAssistantResponse` 先取 `context.messages`，再依次执行可选 `transformContext` 和必需的 `convertToLlm`，最后用原 `context.systemPrompt`、转换后的 messages、原 `context.tools` 构造 provider `Context`。两个转换都不直接改写 system prompt 或 tools。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`streamAssistantResponse`
- 辅助行：281-312

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should apply transformContext before convertToLlm")`
- 辅助行：221-272

**验证：** `source`, `test`

### E03 [contract + source + test] `transformContext` 与 `convertToLlm` 分属两层

**结论：** `transformContext` 在 `AgentMessage[]` 层做裁剪或外部上下文注入，`convertToLlm` 再把应用自定义消息过滤/转换为 provider 理解的 `user | assistant | toolResult`。两者的契约都要求不要 throw/reject，应返回安全兜底值。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentLoopConfig.transformContext`, `AgentLoopConfig.convertToLlm`
- 辅助行：152-200

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should handle custom message types via convertToLlm")`, `it("should apply transformContext before convertToLlm")`
- 辅助行：166-272

**验证：** `contract`, `source`, `test`

### E04 [source + test] `prepareNextTurn` 在下一次 provider 请求前替换运行快照

**结论：** 当前 Turn 的 assistant 和工具结果已写入上下文并发出 `turn_end` 后，`prepareNextTurn` 可以返回新的 context、model 和 thinking level；循环把这些值写入本 Run 的局部快照，下一次 provider 请求立即使用它们。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`runLoop`
- 辅助行：224-245

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/test/agent-loop.test.ts`
- symbol：`it("should use prepareNextTurn snapshot before continuing")`
- 辅助行：1031-1102

**验证：** `source`, `test`

### E05 [source + test] Coding Agent 把动态状态刷新接到 `prepareNextTurn`

**结论：** `AgentSession._installAgentNextTurnRefresh` 保留已有 prepare hook 的结果和 messages，但在每个 Turn 后重新写入当前 base/override system prompt、活动工具副本、当前 model 和 thinking level。因此扩展改变活动工具后，同一 Run 的下一 Turn 才获得新快照。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSession._installAgentNextTurnRefresh`
- 辅助行：540-560

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/test/suite/regressions/6162-extension-active-tools-next-turn.test.ts`
- symbol：同一 Run 刷新活动工具及保留 system prompt override 的回归测试

**验证：** `source`, `test`

### E06 [source + test] Session 先选当前叶路径，再按最新 compaction 边界重建消息

**结论：** `buildSessionContext` 从 leaf 沿 parent 回到 root 得到当前路径，读取路径中的 thinking/model 状态，再用 `buildContextEntries` 应用最新 compaction，最后逐 entry 转成 AgentMessage。非当前分支不会自动混入上下文。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/session-manager.ts`
- symbol：`buildSessionPath`, `buildContextEntries`, `buildSessionContext`
- 辅助行：334-359, 418-469

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/test/session-manager/build-context.test.ts`
- symbol：`describe("buildSessionContext")`

**验证：** `source`, `test`

### E07 [source] Session entry 与 LLM message 不是一一对应

**结论：** 普通 message 原样进入；空/null content 被规范化为 `[]`；`custom_message`、`branch_summary`、`compaction` 变成应用自定义 AgentMessage；thinking/model/custom state/label/session_info 不进入模型上下文。`custom` entry 用于扩展持久化状态，而 `custom_message` 才参与上下文。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/session-manager.ts`
- symbol：`CustomEntry`, `CustomMessageEntry`, `sessionEntryToContextMessages`
- 辅助行：94-140, 379-407

**验证：** `source`

### E08 [source] Coding Agent 的 `convertToLlm` 明确规定自定义消息如何进入模型

**结论：** `bashExecution` 转成 user 文本（`excludeFromContext` 时丢弃）；`custom` 转成 user；branch/compaction summary 包在固定 `<summary>` 前后缀里转成 user；标准三类消息原样保留。`display`、custom `details` 等 UI 元数据不会被拼入 user content。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/messages.ts`
- symbol：`convertToLlm`, `bashExecutionToText`, `COMPACTION_SUMMARY_PREFIX`, `BRANCH_SUMMARY_PREFIX`
- 辅助行：11-24, 79-98, 140-195

**验证：** `source`

### E09 [contract + source] Tool result 同时有模型内容通道和运行时详情通道

**结论：** `AgentToolResult.content` 是文本/图片模型内容；`details` 是任意结构化 UI/日志数据。循环把两者都放入 `ToolResultMessage` 并持久化，但代表性 provider 转换只读取 `content`、tool call id、错误状态及延迟工具字段，不把 `details` 发进 provider tool output。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/types.ts`
- symbol：`AgentToolResult`
- 辅助行：360-375

**补充锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/agent/src/agent-loop.ts`
- symbol：`createToolResultMessage`
- 辅助行：777-790
- file：`packages/ai/src/api/anthropic-messages.ts`
- symbol：`convertToolResult`
- 辅助行：1120-1152
- file：`packages/ai/src/api/openai-responses-shared.ts`
- symbol：`convertMessages` 的 `toolResult` 分支
- 辅助行：296-312

**边界：** `convertToLlm` 在应用层把标准 ToolResultMessage 原样保留，不等于 provider 会序列化其中每个运行时字段；provider adapter 才是最终线协议边界。

**验证：** `contract`, `source`

### E10 [source + test] Base system prompt 是资源、工具和运行目录的确定性拼装

**结论：** `buildSystemPrompt` 接受 custom prompt、活动工具名、tool snippets/guidelines、append prompt、cwd、context files 和 skills。custom prompt 会替换默认主体，但 append/context/skills/cwd 仍可追加；默认主体只列出既活动又提供 snippet 的工具。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/system-prompt.ts`
- symbol：`BuildSystemPromptOptions`, `buildSystemPrompt`
- 辅助行：8-168

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/test/system-prompt.test.ts`
- symbol：`describe("buildSystemPrompt")`

**验证：** `source`, `test`

### E11 [source + test] 项目 context files 是启动/重载时读取的祖先链资源

**结论：** 每个目录按 `AGENTS.override.md → AGENTS.md/AGENTS.MD → CLAUDE.md/CLAUDE.MD` 取首个存在文件；先加入全局 agentDir 文件，再从 cwd 向根扫描并按祖先到子目录顺序加入。内容被直接放入 system prompt 的 `<project_context>`，不是运行时语义检索。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/resource-loader.ts`
- symbol：`loadContextFileFromDir`, `loadProjectContextFiles`, `DefaultResourceLoader.reload`
- 辅助行：70-156, 515-545

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/test/resource-loader.test.ts`
- symbol：`it("should prefer AGENTS.override.md within each directory while preserving ancestor layering")`, `describe("loadProjectContextFiles - nested worktree dedup")`

**验证：** `source`, `test`

### E12 [source] `SYSTEM.md` / `APPEND_SYSTEM.md` 与 ResourceLoader reload 控制 base prompt

**结论：** 受信任项目的 `.pi/SYSTEM.md` / `.pi/APPEND_SYSTEM.md` 优先于全局 agentDir 同名文件；显式输入既可当文件路径读取，也可直接当 prompt 字符串。`AgentSession._rebuildSystemPrompt` 从 ResourceLoader 取这些内容、skills、agents files 和当前工具贡献，再调用 `buildSystemPrompt`。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/resource-loader.ts`
- symbol：`resolvePromptInput`, `DefaultResourceLoader.reload`, `DefaultResourceLoader.discoverSystemPromptFile`, `DefaultResourceLoader.discoverAppendSystemPromptFile`
- 辅助行：54-69, 526-545, 1023-1048
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSession._rebuildSystemPrompt`
- 辅助行：1034-1068

**验证：** `source`

### E13 [source + test] Prompt template 是输入宏，不是常驻 system context

**结论：** ResourceLoader 从用户、项目和显式路径加载 Markdown prompt templates；`expandPromptTemplate` 只在输入以 `/name` 命中模板时把模板正文和参数替换成用户文本。普通 prompt、steering 和 follow-up 都在进入消息队列前展开，模板目录本身不被整批塞入模型上下文。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/prompt-templates.ts`
- symbol：`loadPromptTemplates`, `expandPromptTemplate`, `substituteArgs`
- 辅助行：56-131, 177-278
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSession.prompt`, `AgentSession.steer`, `AgentSession.followUp`
- 辅助行：1130-1175, 1346-1384

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/test/prompt-templates.test.ts`
- symbol：`describe("expandPromptTemplate")`

**验证：** `source`, `test`

### E14 [source] Skills 是“目录元数据常驻、正文按需读取”的机制

**结论：** loader 解析 SKILL.md 的 name/description/path；system prompt 只列出这些元数据，并明确指示模型在任务匹配时使用 read tool 加载 skill 文件。`disable-model-invocation` 的 skill 不进入列表，只能显式命令调用。是否读取正文由模型/命令决定，Core 没有语义路由器。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/skills.ts`
- symbol：`loadSkillFromFile`, `formatSkillsForPrompt`
- 辅助行：276-344, 347-380
- file：`packages/coding-agent/src/core/system-prompt.ts`
- symbol：`buildSystemPrompt`
- 辅助行：63-67, 161-164

**验证：** `source`

### E15 [source] `before_agent_start` 可在一次 Run 开始前注入消息并覆盖 system prompt

**结论：** Coding Agent 先构造 user message，再串行调用各扩展的 `before_agent_start` handler；扩展可追加 custom messages，后一个 handler 看到前一个 handler 已修改的 system prompt。结果作为本 Run 的 `_systemPromptOverride`，Run 收敛后清除。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/extensions/runner.ts`
- symbol：`ExtensionRunner.emitBeforeAgentStart`
- 辅助行：1081-1145
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSession.prompt` 的 `before_agent_start` 分支, `AgentSession._runAgentPrompt`
- 辅助行：1243-1272, 1074-1085

**验证：** `source`

### E16 [source] `context` hook 在每次模型调用前动态重写 messages

**结论：** SDK 把 `Agent.transformContext` 实现为 `ExtensionRunner.emitContext`。runner 先 `structuredClone` 输入，再按扩展/handler 顺序传递返回的 messages；异常被记录并继续。这个 hook 不直接返回 system prompt 或 tools，它们由其他 hook/next-turn refresh 负责。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/sdk.ts`
- symbol：`createAgentSession` 中 `Agent` 的 `transformContext`
- 辅助行：306-372
- file：`packages/coding-agent/src/core/extensions/runner.ts`
- symbol：`ExtensionRunner.emitContext`
- 辅助行：984-1010

**验证：** `source`

### E17 [source + test] 自动 compaction 有 threshold 与 overflow 两类入口

**结论：** 默认设置为 enabled、`reserveTokens=16384`、`keepRecentTokens=20000`；普通阈值是 `contextTokens > contextWindow - reserveTokens`。`AgentSession._checkCompaction` 还单独处理 context overflow / recoverable length：成功响应只压缩，失败或截断响应可移除失败 assistant 后压缩并最多重试一次。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/compaction/compaction.ts`
- symbol：`DEFAULT_COMPACTION_SETTINGS`, `shouldCompact`
- 辅助行：126-136, 232-238
- file：`packages/coding-agent/src/core/agent-session.ts`
- symbol：`AgentSession._checkCompaction`
- 辅助行：2029-2153

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/test/compaction.test.ts`
- symbol：`describe("shouldCompact")`

**验证：** `source`, `test`

### E18 [source + test] `firstKeptEntryId` 是摘要与保留原文之间的持久边界

**结论：** `findCutPoint` 从新到旧累计近似 token，只在可见 user-like 或 assistant entry 上切，绝不从 toolResult 开始；切在 assistant 时会识别 split turn。`prepareCompaction` 记录第一个保留 entry 的 UUID，并分别准备旧历史摘要和 turn prefix 摘要。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/compaction/compaction.ts`
- symbol：`findValidCutPoints`, `findCutPoint`, `prepareCompaction`
- 辅助行：338-460, 736-814

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/test/compaction.test.ts`
- symbol：`describe("findCutPoint")`, `describe("buildSessionContext")`

**验证：** `source`, `test`

### E19 [source + test] Compaction 摘要是独立 LLM 调用，重建后为“摘要 + 保留原文 + 后续消息”

**结论：** 摘要前先用 `convertToLlm` 处理应用消息，再序列化成 `<conversation>` 文本，以专用 system prompt 发起禁止工具的独立模型请求。重复压缩会把 previous summary 放入更新提示；split turn 会另做 prefix summary。保存 compaction entry 后，Session 用该 summary、从 `firstKeptEntryId` 开始的旧 entry 和 compaction 之后的新 entry 重建 agent messages。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/compaction/compaction.ts`
- symbol：`completeSummarization`, `generateSummaryWithUsage`, `compact`
- 辅助行：565-585, 643-705, 844-949
- file：`packages/coding-agent/src/core/session-manager.ts`
- symbol：`buildContextEntries`, `appendCompaction`
- 辅助行：418-453, 1096-1118

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/test/agent-session-compaction.test.ts`
- symbol：`it("should maintain valid session state after compaction")`, `it("should persist compaction to session file")`

**验证：** `source`, `test`

### E20 [source + test + inference] Branch summary 保存“离开的分支”，但不是长期记忆/RAG

**结论：** 导航到旧节点时，branch summary 从旧 leaf 回溯到与目标路径的最近公共祖先，收集被离开路径的 entries；在 token budget 内保留较新的内容，独立调用 LLM 生成摘要，再作为目标节点下的新 `branch_summary` entry。它随后通过 Session conversion 成为 user-role summary。Core 另有线性 Session 文本扫描 API，但 Coding Agent 的上下文组装没有调用它；`InMemorySessionStorage` 也只是存储后端。因此固定源码没有内建向量记忆或自动 RAG 注入。

**源码锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/src/core/compaction/branch-summarization.ts`
- symbol：`collectEntriesForBranchSummary`, `prepareBranchEntries`, `generateBranchSummary`
- 辅助行：108-145, 195-245, 293-378
- file：`packages/coding-agent/src/core/session-manager.ts`
- symbol：`SessionManager.branchWithSummary`, `sessionEntryToContextMessages`
- 辅助行：1381-1405, 401-405
- file：`packages/agent/src/search/scanning.ts`
- symbol：`createScanningSessionSearch`, `defaultMatch`
- file：`packages/agent/src/harness/session/memory.ts`
- symbol：`InMemorySessionStorage`, `InMemorySessionRepo`

**测试锚点：**

- tag：`v0.84.3`
- commit：`4e58f324fae8ebfa98a3d45181fb248072a2afac`
- file：`packages/coding-agent/test/branch-summarization.test.ts`
- symbol：`describe("branch summarization")`
- file：`packages/coding-agent/test/session-manager/build-context.test.ts`
- symbol：`it("includes branch summary in path")`

**推断边界：** “没有内建自动 RAG”来自 `AgentContext` / Coding Agent 组装链没有 retrieval 字段或调用，以及搜索 API 仅作为独立能力导出；不能进一步推断 Pi 扩展无法实现 RAG。扩展完全可以在 `context` hook 中调用外部检索并返回注入后的 messages。

**验证：** `source`, `test`, `inference`

## 本书设计词与源码事实的对应边界

下面四类是本书用于讲解的设计词，不是固定源码中的统一 enum、class 或官方分层名称：

| 本书设计词 | 固定源码中可对应的真实机制 | 不能写成的错误结论 |
| --- | --- | --- |
| Static Context | `buildSystemPrompt` 拼接默认/custom prompt、append prompt、AGENTS/CLAUDE context files、工具说明和 cwd；Session path 中未经压缩的历史消息 | “所有内容永远不变”；ResourceLoader reload、工具切换和 next-turn refresh 都可重建它 |
| Dynamic Context | `before_agent_start` 改 system prompt/注入 custom message；`context` hook 每次模型调用前重写 messages；`prepareNextTurn` 刷新下一 Turn 快照 | “扩展能在一个 context hook 里同时改 messages/system/tools”；这三者有不同入口和时机 |
| Lazy Context | skills 在 system prompt 中只暴露 name/description/location，模型匹配后再 read SKILL.md；prompt template 只有被 `/name` 命中才展开 | “Pi 有统一 lazy loader”；这是两种不同的按需机制，且 skill 读取依赖模型/工具调用 |
| Retrieval Context | 固定 Coding Agent 没有内建自动 RAG；可由 extension `context` hook 自行检索后注入。Core 的 scanning search 是独立 Session 文本扫描 API | “Session search 就是 RAG”或“memory.ts 是长期模型记忆”；两者都没有自动接入 provider Context |

建议正文明确写：“static / dynamic / lazy / retrieval 是本书的观察框架；Pi 源码提供的是若干具体 hook、resource loader 和 compaction primitive。”

## 关键不变量

1. provider 真正收到的 context 只在 `streamAssistantResponse` 形成；应用消息必须先经过 `transformContext` 和 `convertToLlm`。（E01-E03）
2. Session JSONL 不是 provider transcript；必须先选 branch、应用 compaction，再做 entry-to-message 和 message-to-LLM 两层转换。（E06-E08）
3. base system prompt、Run 级 override、每调用一次的 message transform、Turn 级 next snapshot 是四个不同时间尺度。（E05、E10-E12、E15-E16）
4. Tool result 的 `content` 面向模型，`details` 面向运行时；详情可以持久化，但 provider adapter 不把它当 tool output。（E09）
5. compaction 不删除 Session 历史文件；它新增一个带 `firstKeptEntryId` 的摘要 entry，并在重建活动上下文时省略旧历史。（E18-E19）
6. branch summary 概括离开的路径，compaction summary 缩短当前路径；二者最终都转换为 user-role summary，但触发语义和持久边界不同。（E19-E20）
7. 固定源码允许扩展实现 retrieval injection，但没有证据支持“Pi Coding Agent 内建向量记忆/RAG”。（E01、E16、E20）

## 16 条 evidence map 候选

| ID 候选 | 核心问题 | 证据类型 | 主要 symbol | 建议正文落点 |
| --- | --- | --- | --- | --- |
| CE-01 | 一次 provider 请求的最终 Context 由什么组成？ | contract/source | `AgentContext`, `streamAssistantResponse` | Context 的三槽模型 |
| CE-02 | `transformContext` 与 `convertToLlm` 为什么必须分层？ | contract/source/test | `AgentLoopConfig`, `streamAssistantResponse` | Context 流水线 |
| CE-03 | 同一 Run 的下一 Turn 如何拿到新 prompt/tools/model？ | source/test | `runLoop`, `_installAgentNextTurnRefresh` | 动态快照 |
| CE-04 | Session tree 如何变成当前模型消息？ | source/test | `buildSessionPath`, `buildSessionContext` | Session 到 Context |
| CE-05 | 哪些 Session entry 会进入模型，哪些只持久化状态？ | source | `sessionEntryToContextMessages`, `CustomEntry`, `CustomMessageEntry` | 两层消息模型 |
| CE-06 | Coding Agent 自定义消息如何映射成标准 role？ | source | `convertToLlm` | Message conversion |
| CE-07 | Tool result 的 `content` 与 `details` 各给谁？ | contract/source | `AgentToolResult`, `createToolResultMessage`, provider `convertToolResult` | Tool 结果上下文 |
| CE-08 | Base system prompt 如何由工具、资源和 cwd 拼成？ | source/test | `buildSystemPrompt`, `_rebuildSystemPrompt` | Static Context |
| CE-09 | AGENTS/CLAUDE/SYSTEM/APPEND_SYSTEM 如何发现和分层？ | source/test | `loadProjectContextFiles`, `DefaultResourceLoader.reload` | Project Context |
| CE-10 | Prompt template 为什么是输入宏而不是常驻上下文？ | source/test | `loadPromptTemplates`, `expandPromptTemplate` | Lazy Context 之一 |
| CE-11 | Skill 为什么是“元数据常驻、正文按需读”？ | source | `loadSkillFromFile`, `formatSkillsForPrompt` | Lazy Context 之二 |
| CE-12 | `before_agent_start` 与 `context` hook 的时机和权限有何不同？ | source | `emitBeforeAgentStart`, `emitContext` | Dynamic Context |
| CE-13 | 自动 compaction 何时由 threshold/overflow 触发？ | source/test | `shouldCompact`, `_checkCompaction` | Context 预算 |
| CE-14 | cut point、split turn、`firstKeptEntryId` 如何保护工具配对与最近原文？ | source/test | `findCutPoint`, `prepareCompaction` | Compaction 边界 |
| CE-15 | 摘要如何生成并重新进入活动上下文？ | source/test | `generateSummaryWithUsage`, `compact`, `buildContextEntries` | Summary 数据流 |
| CE-16 | Branch summary、Session search、memory/RAG 的真实边界是什么？ | source/test/inference | `generateBranchSummary`, `createScanningSessionSearch`, `InMemorySessionStorage` | Retrieval 边界 |

## 尚需谨慎表述

1. 本次没有执行 upstream 测试；所有 `test` 证据仅代表静态核对断言。
2. 行号只作固定 commit 下的导航辅助；Book 应以 `tag + commit + file + symbol` 为主锚点。
3. `static / dynamic / lazy / retrieval` 是本书设计词，不能说成 Pi 的官方四层架构。
4. `details` 存在于 Agent/Session 消息对象中，但代表性 provider adapter 只编码 `content`；不要简写成“details 在整个系统中被丢弃”。
5. “Pi 没有 RAG”必须限定为“固定 Coding Agent 没有内建自动检索注入”；Core 暴露 Session scanning search，扩展也能通过 context hook 实现外部检索。
6. Compaction summary 与 branch summary 都依赖额外 LLM 调用，可能失败、abort 或被扩展 hook 替换；不要把它们描述为纯本地字符串裁剪。
