# 视频对话文章（video-article）

输入一个带字幕的 YouTube 视频链接，生成按章节组织的中文文章：

- 正文由 Gemini 流式生成，边生成边在页面上显示；
- 全文保存后，每一章都可以查看 5W1H 总结；
- 可以选填一段自然语言要求，调整任务类型、风格、受众和约束条件。

- **在线地址**：https://video-article.kingsleyli920.workers.dev
- **技术栈**：TypeScript、Cloudflare Workers、Durable Object（SQLite）、原生前端、marked + DOMPurify，前端用 esbuild 构建。

## 快速开始

### 本地运行

需要 Node.js 22 或以上。

```bash
npm install
cp .env.example .env      # 本地运行只需要填 GEMINI_API_KEY
npm run dev               # 打开 http://127.0.0.1:8787，点"填入示例视频"即可体验
```

`npm run dev` 会先按白名单从 `.env` 生成 `.dev.vars`，只写入 Gemini 相关的三项，然后启动 `wrangler dev`。改动服务端代码后，如果要验证保存和 5W1H，建议重启 dev：本地热重载之后曾出现过 Durable Object 写入丢失。

### 环境变量

| 变量 | 用途 | 放在哪里 |
|---|---|---|
| `GEMINI_API_KEY` | 调用 Gemini（必填） | 本地：`.env`，自动写进 `.dev.vars`；线上：Worker secret |
| `GEMINI_MODEL` | 模型名，默认 `gemini-3.6-flash` | `wrangler.jsonc` 的 vars；本地可在 `.env` 里覆盖 |
| `GEMINI_THINKING_LEVEL` | 思考强度，默认 `low` | 同上 |
| `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_ACCOUNT_NAME`、`CLOUDFLARE_API_TOKEN` | 只给部署脚本用，用来核对账户 | `.env`；不进入前端构建、Worker 运行环境和线上 secret |

`.env`、`.dev.vars` 都已加入 `.gitignore`。

### 测试

```bash
npm run typecheck          # worker、client、node 三套 tsconfig
npm run test:fast          # L1a 后端单测、L1b 后端功能测试（workerd 和 SQLite DO）、L1c 前端单测（jsdom）；全部 mock，不联网
npx playwright install chromium
npm run test:e2e:ui        # L5 全栈：真实浏览器、真实 YouTube 和 Gemini，会消耗额度
E2E_BASE_URL=https://video-article.kingsleyli920.workers.dev npm run test:e2e:ui   # 对线上运行
```

另外有两个手动工具：

- `scripts/stream-probe.ts`：对本地或线上发起一次真实生成，按网络分块记录到达时间。
- `scripts/screen-model.ts`：用固定的字幕和提示词直接调用模型，用于模型对比。

### 部署

部署只能通过 `scripts/cf.ts` 进行。它会依次核对：

- `.env` 里的令牌有效；
- 目标账户的完整 ID 和账户名与 `.env` 一致；
- 令牌只能访问这一个账户，并且有 Workers 权限；
- wrangler 实际用的是项目令牌，而不是本机的全局登录。

写操作还要求先有一条人工确认记录。

```bash
npm run cf:verify                         # 只读核对
npm run cf:confirm -- "<账户名>"           # 确认是个人账户后记录一次
npm run cf:secret:gemini                  # 把 .env 里的 GEMINI_API_KEY 写成线上 secret（经 stdin）
npm run deploy                            # 构建前端并部署
```

令牌需要的权限：Account 下的 Workers Scripts（Edit）、Workers Tail（Read）、Account Settings（Read）。

## 1. YouTube 字幕的获取、清洗、示例备份与失败处理

代码在 `src/worker/youtube.ts` 和 `src/worker/transcripts.ts`。

**获取**：先以 ANDROID 客户端身份调用 InnerTube 的 `youtubei/v1/player` 接口，拿到字幕轨列表，再从 `timedtext` 拉取 `fmt=srv1` 格式的字幕。

- 2026-11 实测：网页端给出的字幕地址缺少 PO token 时返回空内容，所以改用 ANDROID 客户端。
- srv1 的体积大约是 json3 的十分之一，可以少做一些 JSON 解析。

**选字幕轨**：排除自动配音的变体轨（地址带 `variant`）。优先选和原声同语言的人工字幕，其次是原声的自动识别字幕，最后才是任意一条人工字幕。

**清洗**：

- srv1 的文本是两层转义，要解码两次。
- 自动字幕用 `>>` 表示换人说话。在这里另起一段并保留标记；同一人说得过长时，在片段边界分段；每段开头标上时间 `[mm:ss]`。
- 遇到"前面没有数字的千分位片段"（例如 `of,200`），标注〔字幕数字残缺〕，提醒模型不要把它补成某个确定的数。示例字幕里只有这 1 处。生成结束后还会再检查一次，见第 3 节。
- 字幕整理后超过 30 万字符时，直接报 `transcript_too_long`。

**时间上限**：

- player 请求 10 秒，字幕请求 15 秒，两者都包含读取响应正文。实测这两步合计 0.3 到 1.8 秒。
- 另用 `Promise.race` 卡住时限：即使正文读取不响应中止信号，也会按时结束。

**示例备份**：`src/worker/transcripts/xRh2sVcNXQ8.json` 是示例视频的真实字幕，共 2801 条。

- 它由 `npm run transcript:fetch` 用同一个模块抓取，记录了抓取方式、字幕轨和抓取时间。
- 和一次独立抓取逐条比对过，完全一致。
- 只有示例视频在实时获取失败或超时时才会用它，页面会写明"内置备份"以及实时获取失败的原因。

**失败处理**：

- 其他视频遇到以下情况都会给出明确的提示和"重新生成"入口：没有字幕、视频不可播放、被 YouTube 拦截（`youtube_blocked`）、超时（`youtube_timeout`）。
- 客户端已经断开导致的取消不走备份。

**已知风险**：YouTube 会间歇性拦截 Cloudflare 的出口 IP，返回"Sign in to confirm you're not a bot"。第二轮线上 3 次生成里有 1 次被拦截，最后一轮 3 次里有 2 次。题目建议的 webshare 代理（经 Worker TCP socket）还没有接入。

## 2. Gemini 调用与完整流式链路

代码在 `src/worker/gemini.ts`、`generate.ts`、`event-stream.ts`，以及 `src/client/api.ts`、`generation.ts`。

**模型和参数**：

- `gemini-3.6-flash`，`thinkingConfig.thinkingLevel = "low"`，`maxOutputTokens = 32768`，temperature 等其他参数用模型默认值。
- 请求结构：`systemInstruction` 放写作规则；一条 user 消息依次放视频元数据、整理后的字幕、用户要求。

**链路**：

1. 浏览器 `POST /api/generations`。Worker 校验输入后立即返回 `text/event-stream`，后台依次推送 `stage`、`meta`（generationId、视频、字幕来源）、若干 `delta`，最后是 `done` 或 `error`。
2. Worker 调用 `streamGenerateContent?alt=sse`。`readSse` 增量解析上游的 SSE：分块切在行中间、`\r\n` 之间、UTF-8 多字节字符中间，都能正确还原。
3. 每收到一段正文，就 `await` 写成一个 `delta` 发给浏览器，并且保留背压。
4. 浏览器用同一个 `readSse` 读取，收到正文后至多每 80 毫秒重绘一次：先用 marked 渲染，再经 DOMPurify 清洗。生成中显示阶段和已用时间。

**结束条件**：

- 收到带 `finishReason` 的终止事件后，先处理其中的最后一段正文，再立即停止读取并释放连接，不等 HTTP EOF。
- 结束原因：
  - `STOP`：只有同时满足结构有效、Durable Object 保存成功，才发 `done`；
  - `MAX_TOKENS`：报"截断"；
  - 安全拦截：报"被拦截"；
  - 没有终止事件就断流：报"中断"。
- 前端收到 `done` 或 `error` 立即结束消费；之后连接上发生什么，都不会改变已经展示的结果。

**超时、心跳与取消**：

| 位置 | 机制 | 时长 |
|---|---|---|
| Worker 调 Gemini | 首个分块（从发请求开始计时，包含 503 的那一次重试） | 120 秒 |
| Worker 调 Gemini | 输出空闲：每条消息处理完后重新计时，等下游写入的时间不算 | 60 秒 |
| Worker 调 Gemini | 5W1H 结构化请求整体 | 90 秒 |
| Worker 写给浏览器 | 单次写入受阻（和模型空闲分开计时） | 30 秒 |
| Worker 写给浏览器 | 心跳（SSE 注释，固定间隔；有写入在排队时跳过） | 15 秒 |
| 浏览器 | 收不到任何字节（包括心跳） | 45 秒 |
| 浏览器 | 整次生成上限 / 5W1H | 10 分钟 / 100 秒 |

取消是这样传递的：

- 浏览器点"停止生成"会中止 fetch。
- Worker 端以下几种情况都会让 `EventStream.signal` 中止：输出流被关闭或出错、写入失败、写入超时。
- 这个信号会立即取消进行中的 YouTube 和 Gemini 请求。
- 模型结束后、开始保存前，还会再检查一次取消状态。检测到取消后，不再启动新的生成或保存；但已经发出的保存请求可能仍会完成，取消和保存之间没有做成原子的。

开始输出之前遇到 503 只重试一次；开始输出之后不重试，也不换模型，不会把两次输出拼成一篇。

## 3. 用户要求如何影响输出，以及字数口径

提示词在 `src/worker/prompts.ts`，分为五部分：

1. **结构要求**：一个一级标题、至少一章、每章的标题和正文都不能为空。代码里有同样的校验，不满足时不保存，也不开放 5W1H。
2. **忠实度规则**：
   - 只写字幕里有的内容；
   - 每个回答只写这一次问答里说过的话；
   - 保留原问题的比较对象；
   - 数量级按对照表换算；
   - 残缺数字不补全，括号里的"原文"只能照抄字幕；
   - 专名有依据才纠正；
   - 不把"公司"收窄成"初创公司"；
   - 中文表达自查。
3. **人物身份与发言归属**：
   - 字幕里的直接依据可以确认身份；单人演讲可以用署名标题确认演讲者；字幕里出现的名字可以借本期简介补全姓名；
   - 频道层面的通用介绍不算依据；
   - 身份有依据，不等于每句话的归属都有依据。
4. **用户要求**：只在任务类型、输出风格、目标受众、约束条件（篇幅、范围、章节数）四个方面生效。和上面三部分冲突的，或者超出这四个方面的（例如编造内容、换成其他语言），都会忽略。
5. **默认写法**：没有填要求时，写成中文视频对话文章，按话题分章，问答体，覆盖整段视频。

**字数口径**（`countArticleChars`，在 `src/shared/article.ts`）：

- 统计文章标题和正文的非空白字符，中文、英文、数字、标点都计入；
- Markdown 标记和空白不计入；5W1H 不计入；
- 提示词、页面上显示的字数（`done.chars`）和验收用的是同一个函数。

用户给了字数上限时，提示词要求以上限的九成左右为目标，验收仍按原上限判断，不放宽，也不通过截断来达标。

**残缺数字的检查**（`src/worker/number-check.ts`）：

- 提示词约束不住模型补数，实测多次把 `of,200` 写成"1200"，所以生成结束后用程序再查一遍。
- 判定方法：字幕里每一处〔字幕数字残缺〕，看文中有没有以这三位数结尾、但位数更多的数字（如 1200、1,200），并且这个数在字幕别处没有完整出现过。
- 查到了就随 `done` 事件发给页面，在文章标题下方提示"这个数没有字幕依据，请以原视频为准"，状态条也会提一句。
- 正文不做任何修改，也不会因此重新生成。
- 识别不了中文数字（"一千二百"）和"上千""数千"这类说法；也不判断位置，文中别处恰好有同样结尾的数会被多提示一次。

## 4. 服务端上下文与章节级 5W1H

代码在 `src/worker/store.ts`、`summary.ts`、`summary-schema.ts`。

**上下文存储**：

- 每次生成对应一个 SQLite 存储的 Durable Object，generationId 就是 DO ID 的字符串形式，不可猜测。
- 存的内容包括视频元数据、字幕全文（整理后的版本）、字幕来源、用户要求、文章 Markdown 和章节列表。
- 模型以 `STOP` 结束并且结构有效时才保存。DO 的存储是强一致的，RPC 返回时写入已经确认，紧接着的读取一定能看到。
- 保存时设置一个 7 天后的 alarm，到期调用 `deleteAll()`。之后再访问这次生成会返回 404，页面提示重新生成。

**5W1H**：

- 请求形式是 `POST /api/generations/:id/chapters/:chapterId/summary`，只有路径参数，带请求体一律返回 400。
- DO 读取字幕全文、用户要求、全部章节标题和当前章节，按 JSON schema 生成 who、what、when、where、why、how 六个字段，校验通过后按章节缓存。
- 空字符串统一成 `null`，页面显示为"原文未明确提及"。
- 提示词要求事实以字幕为准，当前章节只用来确定总结范围；章节里的推测和字幕里残缺的数字，不能当成确定事实写进总结。这是提示词约束，不是程序校验。
- 同一章节的并发请求在 DO 里共用一个进行中的 Promise，只调用一次 Gemini。前端在请求进行中不会重复提交，再次点击只是展开或收起。
- 章节 id 由前后端共用的解析函数按顺序生成，所以同一篇文章的 id 是稳定的。

## 5. 主要工程取舍与亮点

- **不引入额外的存储服务**：一次生成对应一个 Durable Object，生命周期和清理都比较简单。代价是没有列表或检索能力，这个题目也用不上。
- **按 marked 的词法 token 识别章节**：不用字符串或正则切分，代码块、引用里的 `##` 不会被误认成章节。前后端共用同一份代码。
- **流式链路的每一环都有明确的结束和超时**：上游、下游写入、浏览器空闲分开计时；客户端离开后，上游会被及时取消。
- **忠实度靠规则加确定性的输入标注**：比如残缺数字的标记。没有加每次都要重写全文的第二阶段，因为它会让调用次数和延迟都翻倍。
- **凭据和部署隔离**：
  - Cloudflare 令牌只给部署脚本用，部署前完整核对账户 ID；
  - `.dev.vars` 按白名单生成；
  - `npm run check:leaks` 检查前端产物和 Worker 打包产物里没有凭据。
- **不用前端框架和 Vite**：页面只有一个表单、一篇文章和若干面板，原生 TypeScript 加 esbuild 就够了。

## 验证

- **mock 测试**：L1a、L1b、L1c，覆盖链接解析、字幕选轨和超时、SSE 跨分块解析、终止事件、上游取消、写入受阻、断开检测、章节识别和结构校验、字数口径、DO 保存和过期、5W1H 的输入边界、并发合并与缓存、前端的结束、取消和超时。关键用例都做过定向变异验证：故意改坏代码，确认对应测试会失败。
- **真实验收**：线上最终配置，`gemini-3.6-flash`、思考强度 low，2026-11-25。
  - 完整流程（L5，真实浏览器）：
    - 第一段正文 1.8 秒到达浏览器，模型 32.5 秒结束，保存成功，6 章 6,140 字。
    - 这次实时字幕被 YouTube 人机验证拦截，自动用了示例视频的内置备份，页面写明了原因。
    - 第 2、3 章的 5W1H 各用时约 3.4 秒，请求不带请求体。
    - 涉及残缺数字的第 3 章，5W1H 没有沿用文中的推测数字。
  - 停止生成（真实浏览器 + `wrangler tail`）：
    - 浏览器：点击后 32 毫秒显示"已停止生成"，保留 386 字符的部分正文，表单恢复可用，5W1H 按钮保持禁用。
    - 服务端：生成开始后 8,032 毫秒发现客户端断开，同一毫秒中止了对 Gemini 的请求；Cloudflare 记录结果为 `canceled`，没有保存。
    - Gemini 服务端是否随之停止计算，从这一侧观测不到。
  - 自定义要求：
    - "只保留商业化、定价、成本相关问答；全文不超过 1500 字"：统一口径 1,402 字，范围符合要求。
    - "另一视频（斯坦福演讲）+ 写给高中生的学习笔记 + 固定章节结构"：上一轮全部满足。

## 已知限制

- **Gemini 额度**：
  - 免费档下，`gemini-3.6-flash` 每个项目每个模型每天只有 20 次请求，来自 429 返回的 `GenerateRequestsPerDayPerProjectPerModel-FreeTier`。生成文章和每章首次 5W1H 各算 1 次，多试几次就会碰到上限，按太平洋时间午夜重置。
  - 最后一轮验收时额度已经用完，线上用的 key 所在项目改成了预付费的付费档，没有开启自动续充。余额用完后请求会失败；如果改回免费档，限制同上。
  - 2026-11-25 05:45Z 前后筛选时，`gemini-3.8-flash` 连续返回 503；`gemini-4-hydrogen` 首个正文要 51 秒，而且流中途也返回了 503。所以仍然使用 3.6 Flash。
- **内容忠实度**：规则还没能稳定约束住，同样的问题在不同次生成之间时有时无。最终配置的那次默认生成里：
  - "hundreds of billions" 被写成"数百亿"；
  - 残缺的 "of,200" 写成了"1200项〔字幕数字残缺〕"，保留了标记，但仍给出了确定的数；
  - 定价问题的比较对象 seats 被改掉；
  - 有 2 处英文混入；
  - 第 2 章 5W1H 补了一个字幕和元数据里都没有的主持人名字。

  这一轮没有加"每次都重写全文"的第二阶段。
- **YouTube 拦截**：见第 1 节。示例视频以外的视频遇到拦截会失败，代理还没接入。
- **Workers 免费版的 CPU**：线上生成请求实测 21 到 94 毫秒 CPU，超出文档写的每请求 10 毫秒，但目前没有被中止。CPU 随输出篇幅增长；具体开销在哪一步，线上没有做过分解。5W1H 和轻量请求的 CPU 在 12 毫秒以内。
- **没有验证过**：从 Gemini 不支持的地区（如香港）访问、无字幕视频、超长视频；Durable Object 的 7 天过期只在测试环境里验证过。

## 目录结构

```
src/
  client/       页面、状态机、流式消费、文章渲染、5W1H 面板
  shared/       章节解析和字数、SSE、类型、错误文案、大小上限、链接解析
  worker/       路由、生成流程、EventStream、Gemini、YouTube、提示词、Durable Object
    transcripts/xRh2sVcNXQ8.json   示例视频的真实字幕备份
scripts/        部署核对（cf.ts）、.dev.vars 白名单、前端构建、探针、模型筛选、泄漏检查、字幕抓取
test/           be-unit（L1a）、be-ft（L1b）、fe-unit（L1c）、e2e（L5）、fixtures
```
