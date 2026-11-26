# 接续运行验收

Proof of Done — Verified（本地受控 HTTP / 浏览器阶段）。本记录验证当前源工作树的收尾流程；最终审查包交付由后续任务完成，不能据此宣称整项交付已完成或修复已部署。

执行日期：2026-11-25（America/Vancouver）；对应系统 UTC 时间为 2026-11-26。以下“通过”均限定于明确列出的检查。

## 检查对象与环境

- 注册源项目：`<repo>`。
- 实际检查工作树：源项目下 `.claude/worktrees/continue-previous-work-90e737`，提交基线 `007dea6` 加已保留的未提交修复。源项目根目录仍是较早实现，不作为本次修复运行入口。
- 执行位置：从实际源工作树复制源码、测试和配置建立的临时隔离副本；依赖复用源工作树 `node_modules`。没有将不完整的协作捕获直接当成完整运行环境。
- Node v26.9.0、darwin arm64；TypeScript 7.0.2、Wrangler 4.168.0、Vitest 4.1.12、Playwright 1.65.1，桌面 Chromium 1280 × 860。
- 真实本地 Wrangler/workerd、SQLite Durable Object、前端构建产物及浏览器；YouTube 和 Gemini 使用项目模拟上游。没有使用 `page.route` 替换 Worker 的生成或总结响应。
- HTTP 使用独立端口 `18998/18999`，浏览器使用 `18888/18890`。测试配置和本地存储只在隔离副本内生成。测试 Worker 使用假凭据，启动环境白名单排除真实 Gemini / Cloudflare 凭据，不读取源项目 `.env`、`.dev.vars`。
- 沿用测试环境的 `TIMEOUT_SCALE=0.05`：核对主模型 7.5 秒、主备合计 10.5 秒。没有据此验证生产超时的绝对时长。

本次发现私有协作捕获中仍有旧修复版本和遗漏文件。已从实际源工作树恢复 25 个原有实现、测试及运行配置文件，另外恢复后续新增 HTTP 用例所在的测试文件，再补本次测试。恢复没有改变源项目已有产品实现。完整源码及测试版本绑定见 [版本清单](evidence/codex-validation/manifest.json)。

## 本轮直接执行结果

| 检查 | 实际结果 | 证据 |
|---|---|---|
| 收尾 HTTP 回归 `test/be-e2e/review.test.ts` | 8 项通过，退出码 0，17.51 秒 | [HTTP 输出](evidence/codex-validation/http-validation.log) |
| 受控全栈浏览器 `test/e2e/fullstack/review.spec.ts` | 4 项通过，退出码 0，15.9 秒 | [浏览器输出](evidence/codex-validation/browser-validation.log) |
| Worker、客户端、Node 三配置类型检查 | 全部通过，退出码 0；采样修复后再次检查 | [类型检查输出](evidence/codex-validation/typecheck-validation.log) |
| 浏览器前端构建 | Playwright webServer 的 `npm run build` 成功，并实际加载该产物运行上述用例 | 同浏览器输出及截图 |
| 最终截图审阅 | 4 张全部逐张查看，正文、修订记录、5W1H 表格及失败提示无明显截断或重叠 | 见下表 |

### HTTP：失败必须经真实接口暴露

在已有 5 项 HTTP 用例上新增 3 项协议失败回归。模拟上游增加 `kind: response` 场景，可返回合法 JSON 但不满足核对协议的内容。

| 场景 | 已直接检查的结果 |
|---|---|
| 核对响应不是 JSON | SSE 最后是 `review_failed` / `partial: true`；没有 `done` 或 `revised` |
| 合法 JSON 缺少 `issues`（`{}`） | 同上，不能当成“未发现问题”后成功 |
| `issues` 不是数组（`{ issues: {} }`） | 同上，不能误保存 |
| 上述三项的数据保存 | 取 SSE 中的 generationId 请求真实 5W1H 接口，均返回 404 `generation_not_found`，模拟上游没有收到总结请求 |
| 有效局部修订 | SSE 的 revised 是最终全文；后续 5W1H 上游提示包含修订句、不包含原错句 |
| 符合字数约束的整篇修订 | revised 为 46 字修订稿，done 的检查和后续 5W1H 均使用该版本 |
| 重写稿超过全局上限 | `article_too_long`，不发 done/revised、不进入内容核对；5W1H 404 |
| 核对阶段取消 | 两章上游连接均被中止；等过原本完成时点后，5W1H 仍 404 |
| 主备核对均不响应 | 缩短后的预算内报 `review_failed`，相关连接中止；5W1H 404 |

SSE 已开始时 HTTP 状态仍为 **200**；失败通过流末尾 `error` 事件表达，不应将其写为 HTTP 4xx/5xx。格式无效时直接失败，不属于繁忙/超时的备用切换条件。对“不保存”的检查通过公开总结接口验证上下文不可用，没有直接查询 SQLite 内部表。

### 浏览器：最终显示及 5W1H 使用同一版本

| 用例 | 直接检查与截图 |
|---|---|
| 初稿流式增长，随后进入核对 | 核对前有 44 条中间长度样本，正文从 0 增至 101 字符；核对中显示初稿且两章 5W1H 禁用，完成后可用。[最终状态](evidence/codex-validation/browser-1.png) |
| 修正“2003 年投资”的时间归属 | 正文改为“2003 年搬到硅谷，之后十年投资”；原句只保留在展开的修订记录，列出理由和字幕依据；页面显示总结表格，模型收到的 current_chapter 是最终稿。两章浏览器总结请求均只带路径、无请求体。[修订及总结](evidence/codex-validation/browser-2.png) |
| 初稿超出 60 字上限，修订成 56 字 | 页面经历修订和核对阶段，最终正文及字数提示一致，核对记录显示 113 → 56；5W1H 上游提示为修订稿。[修订成功](evidence/codex-validation/browser-3.png) |
| 修订后仍有 93 字，要求不超过 60 字 | 页面显示具体失败原因、未通过核对提示和重新生成按钮；保留初稿供查看，5W1H 禁用，强制点击也不发送请求。[失败状态](evidence/codex-validation/browser-4.png) |

截图 1 的模拟核对故意返回空问题列表，保留了夹具中的错句，用于验证无修订时的状态流程；它不证明内容语义正确。截图中的“实时获取”等文字来自生产 UI，但这轮网络依赖均是本地模拟上游。

## 本轮失败、修正与证据保留

- 新增 HTTP 检查首轮为 7 过、1 失败：测试错误地预期无效 JSON 会切备用。实际模型层对格式错误直接失败；修正此内部行为断言，保持 error、不发 done、不保存等核心断言，随后 8 项全过。[首轮输出](evidence/codex-validation/http-initial-failure.log)
- 浏览器启动前两次命令分别因 `--project` 参数吞掉文件名、测试工具路径缺少 `tsx` 而未进入测试；改用 `--project=fullstack` 并补齐进程 PATH 后正常启动。这是运行入口修正，不是产品修复。
- 浏览器首轮为 2 过、2 失败：固定 40ms 采样漏掉本地快速返回时短暂显示的“正在获取字幕”。测试现保留 40ms 正文样本，并用 MutationObserver 记录状态栏 DOM 变化，没有放宽阶段顺序或最终稿断言。重跑 4 项全过。[首轮输出](evidence/codex-validation/browser-initial-failure.log)
- 截图采集只在隔离副本的 afterEach 中加入，不改变产品。源测试保留采样改进；HTTP 临时端口替换也仅用于本次执行副本。

## 与历史证据的区分

[测试矩阵](TEST_MATRIX.md#14-接续检查与校验修复007dea6-工作树及未提交修复)记录的 207 项定向单测、68 项 Worker 功能测试、5 项 HTTP 回归与历史全量 704 项 Vitest / 89 项浏览器结果，本轮没有再次全量执行。它们保留为先前执行记录，不与本轮 8/4 简单相加。

只读核验确认原修复同步清单中的 13 个源文件及更早基线清单中另 16 个路径仍匹配；但未在当前留存目录找到 207/68/5 的独立原始输出日志，因此这些数字不能升级为本轮重新审阅原始日志的证据。本记录新增的 HTTP、浏览器和类型检查结果均保存实际输出。

七篇线上文章、V13/V15 内容问题、320 次字幕探针及其中 79 次区域路径恢复仍以 [补充验收](ADDITIONAL_ACCEPTANCE.md#接续核对7篇线上文章与字幕恢复探针) 为准。本轮受控验证不覆盖这些线上文章的内容修复，也不证明新提示在真实模型上的语义效果。

## 源同步与交付边界

- 执行前从真实源文件保存基线，运行后再次检查源 `src` / `test`，没有运行期间漂移；同步新增测试前再次核对其各自源基线。
- 本轮源写入仅为 `test/harness/mock-upstream.ts`、`test/be-e2e/review.test.ts`、`test/e2e/fullstack/review.spec.ts`、本记录及其轻量证据。已有产品代码保持原修复版本。
- 同步后比较实际源与私有树：全部 `src` / `test` 文件、恢复的脚本和配置以及本轮文档证据逐文件一致。运行副本与交付版本的测试差异仅为上述端口和截图采集；版本清单单列这些差异。
- 保留 4 张最终截图、5 份输出日志与版本清单；不交付测试数据库、假 key 配置、原始请求头、浏览器 trace / 录像、依赖或临时构建。
- 没有部署、push、调用真实模型或修改线上数据。当前结果不证明生产版本已包含这些修复；手机视觉和新的真实模型语义回验也未包含在本轮受控验收内。
- `review.zip` 的重建、脱敏内容检查及源项目根目录交付属于后续任务，本记录没有提前给出通过结论。

## 复现入口

在具有项目依赖的干净副本中运行；本轮使用的副本排除了凭据和历史本地状态：

```bash
npm run typecheck
./node_modules/.bin/vitest run --project be-e2e test/be-e2e/review.test.ts --reporter=verbose
PATH="$PWD/node_modules/.bin:$PATH" CI=1 E2E_WORKER_PORT=18888 MOCK_UPSTREAM_PORT=18890 \
  ./node_modules/.bin/playwright test --project=fullstack test/e2e/fullstack/review.spec.ts
```

HTTP 测试默认端口为 `8798/8799`；本轮在隔离副本里替换为 `18998/18999` 以避免碰到其它会话。命令运行的是本地受控全栈，不要改成 `live` 来复现本记录。
