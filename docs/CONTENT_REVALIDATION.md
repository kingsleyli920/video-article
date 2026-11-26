# 真实模型内容复验

**最新规则的工程检查已通过，真实模型内容效果尚未验证。** 第五轮两例均因Gemini账户预付额度耗尽返回HTTP 402，在生成正文前中止；需要账户预付额度恢复后才能继续真实复验。本项目接续工作与两例内容验收均未完成。

前四轮的改善与失败全部保留。第四轮经济案例补回语义限定后超过1500字上限，正确失败而没有保存最终稿；SQL仍有未口述符号与假设语气的待改项。随后增加了篇幅预留和通用符号、假设边界规则，但不能用工程测试或此前输出代替最新规则的真实内容结果。

## 复验方法与首轮环境

复验沿用原有用户要求和已存字幕，没有加入案例专用提示，也没有重新下载字幕。实际运行入口为私有项目的 `.claude/worktrees/continue-previous-work-90e737`，各轮执行时的运行源码与注册源项目同名工作树逐文件一致；源项目根目录的较早实现不是运行入口。后续规则发生修改后，历史摘要按当轮快照核对，不能再要求与当前源码相同。

各轮使用真实本地 Wrangler/workerd 和 SQLite Durable Object。YouTube 由已存字幕替代，Gemini 请求转发至固定 Google 官方 HTTPS 地址。流程执行要求提取、文章生成、核对及保存前检查；成功轮次通过临时只读入口回读生产 `GenerationStore.load()`，比较最终正文和字幕，不额外调用5W1H。失败轮次只保留实际收到的输出，不伪造最终稿或保存回读。

| 项目 | V13：经济笔记 | V15：SQL课程笔记 |
| --- | --- | --- |
| 视频 | `PHe0bXAIuk0` | `vHYeChEf2lA` |
| 执行时间（UTC） | 2026-11-26 03:56:38–03:58:02 | 2026-11-26 03:56:48–03:59:14 |
| 实际 Node 环境 | v22.15.0，darwin arm64 | v26.9.0，darwin arm64 |
| 已存字幕 | 26,211字符 | 67,749字符 |
| 模型请求 | 5次：要求提取1次、生成1次、核对3次 | 同左 |
| 模型与档位 | `gemini-4-hydrogen`；要求提取 `low`，生成及核对 `high` | 同左 |
| 上游与入口结果 | 全部HTTP 200、STOP；入口退出码0 | 同左 |
| 最终稿 | 3章，统一口径1,339字 | 3章，统一口径8,306字 |
| 初稿与局部修订 | 初稿1,314字，采用1处修订 | 初稿8,318字，采用3处修订 |
| 服务端保存完成 | 82.230秒 | 144.017秒 |
| 其他模型流程 | 无备用切换、整篇重写或5W1H请求 | 同左 |

V13的三章、1500字上限检查通过。V15原要求没有硬性章数限制，三个章节覆盖查询、筛选、排序与聚合，排序和聚合合并在第三章，不能把它记作“四章”。上述字数采用项目生产解析器的统一口径，不与Markdown原文字符数混用。

两例分别绑定原始 `input.json`、`preflight.json`、`raw-cues.json` 和 `prepared.txt` 四份输入，以及34份实际运行源码。生成和每章核对请求中的字幕均与对应 `prepared.txt` 逐字一致；保存回读的字幕和最终文章也与实际请求、最终SSE一致。绑定清单见 [V13执行记录](evidence/content-revalidation/V13/provenance.json) 和 [V15执行记录](evidence/content-revalidation/V15/provenance.json)。

已存预检没有视频简介，本轮明确使用空简介，不联网补取。因此能确认字幕与原始用户要求相同，不能声称与历史线上模型请求的全部元数据相同。两例Node版本也不同，已按实际执行分别记录。

## 首轮V13：讲者框架已保留，来源限定与因果仍待改

原要求是面向大学生写三章、最多1500字的经济学笔记，区分货币、信用、收入、债务，金额比例按字幕，不补投资建议。旧线上稿没有明确交代讲者的简化框架归属，结尾也把讲者建议写成了作者训诫。

| 检查点 | 首轮改善或正确保留 | 尚未关闭的部分 |
| --- | --- | --- |
| 讲者框架与结尾建议 | 开头明确“在雷·达里奥的简化分析框架中”，结尾三条明确归为讲者的“经验法则”；未新增投资建议。 | 这两处改善不能代替其余事实的核对。 |
| 美国50万亿信用、3万亿货币 | 数值及货币、信用的区分正确。 | 两句仍是没有明确时间来源的现在式，需就近保留“视频举例”等语境，不能只依赖全文开头的框架归属，也不能补字幕没有的统计日期。 |
| 短、长期周期 | 保留5至8年、75至100年两个区间。 | 字幕有 `about`、`typically`，新稿漏掉约数语气，应避免写成固定周期。 |
| 违约、挤兑与债务重组 | 保留了债务减少这一主题。 | 把违约与重组并列写成挤兑的直接原因。字幕先讲不能还款引发担忧、挤兑，随后讲放贷人为避免资产完全消失而同意重组；二者因果位置不能合并。 |
| 政策因果 | 唯一模型修订有效移除了“向富人加税直接导致债权债务国矛盾”的因果越界，将紧张局势放回萧条持续的背景。 | 降息段省略了“衰退过于严重且通胀不再构成问题”的条件，需在通用规则收尾时处理。 |
| 债务负担与政府债务 | 保留民众收入增加、债务相对收入下降的方向。 | 省略了“政府债务同时增加”的重要说明；当前稿没有反向声称政府债务下降，应把遗漏与相反陈述区别处理。 |

货币、信用、债务、收入的核心区别，10万→11万→12.1万美元的借贷例子，2008年美联储超过2万亿美元，以及100%债务收入比、2%利率、1%收入增长的演示比例，首轮核对未发现新增错误。稿件保留避免过量印钞和恢复“约十年或更久”的边界，没有无条件宣称印钞不引发通胀。

详见 [V13首轮审阅](evidence/content-revalidation/V13/audit.md)、[初稿](evidence/content-revalidation/V13/draft.md)、[最终稿](evidence/content-revalidation/V13/article.md) 和 [模型修订](evidence/content-revalidation/V13/revisions.json)。这些文件保留原始模型结果，没有手改文章冒充改善。

## 首轮V15：ANSI语气已保留，来源冲突提示仍有漏项

原要求是给SQL初学者整理课程笔记，按查询、筛选、排序与聚合组织，只列字幕明确口述的代码和结果，并保留学生提问与讲师回答的归属。旧稿把“I believe”带有不确定性的ANSI回忆写成确定断言，并把“五年”与“2018至2023”合成一个确定说法。

| 检查点 | 首轮改善或正确保留 | 尚未关闭的部分 |
| --- | --- | --- |
| ANSI不确定语气 | 写为“他回忆好像是ANSI”，没有将讲师的回忆变成确定事实。 | 仅证明本轮这一处保留正确，不能推断所有不确定表述都可靠。 |
| “五年”与“2018至2023” | 分别转述讲师开场与稍后的说法，没有再直接合成“2018至2023年共五年”。 | 没有明确说明来源口径不一致；不能替字幕算年数、选边，也不能借78条记录裁定。 |
| 4.932与4.392 | 分别保留口述筛选值与随后读数，没有默默统一。 | 同样没有直接提示来源前后不一致。 |
| 师生归属 | 主讲人是Carter Zenke，提问与回答角色正确，没有写成David Malan。 | 字幕明确点名的Vinayak、Tayas被压缩为“学生”；这是信息压缩记录，不据此判定角色归属失败，也不要求所有人物细节逐一保留。 |
| 数值比较边界 | 查询保留评分 `>4.0`、票数 `>10000` 及结果4本。 | 概述用了“至少一万”，应收紧为“超过一万”，不能把 `>` 改成含边界值的说法。 |

来源冲突检查关注读者能否看出两种口径尚未统一，不是借外部知识判定哪个年份或读数正确。分别保留两种说法是改善，仍不能等同于已满足明确提示来源差异的要求。

以下SQL锚点首轮保留正确：`COUNT(*)`的78行、`COUNT(translator)`的76个非空值、`COUNT(DISTINCT publisher)`的33个不同出版社；`MAX/MIN`作用于书名时按字母顺序而非字符串长度；`.quit`不是SQL关键字；拼错的列名作为错误示例解释，没有当成正确列名。

三处模型修订分别处理了中英混杂用语、“书中”与“表中”的对象错误，以及字幕没有明确口述的空值等号附加断言。修订有字幕依据，但没有涉及年份与读数冲突提示，不能据此判整篇合格。本轮没有执行生成的SQL，也没有用屏幕画面补全字幕缺失信息。

详见 [V15首轮审阅](evidence/content-revalidation/V15/audit.md)、[初稿](evidence/content-revalidation/V15/draft.md)、[最终稿](evidence/content-revalidation/V15/article.md) 和 [模型修订](evidence/content-revalidation/V15/revisions.json)。

## 第二轮：SQL重点通过，经济仍需调整

第一次通用修订收紧了视频数值的就近来源、约数和比较边界、条件与因果，以及字幕内部口径冲突的呈现；同时明确这些限定的遗漏不能按“合理压缩”免责。两例继续使用原要求、已存字幕和真实官方模型，没有加入专用答案。

| 项目 | V13：经济笔记 | V15：SQL课程笔记 |
| --- | --- | --- |
| 实际请求 | 5次：提取1、生成1、逐章核对3 | 6次：提取1、生成1、逐章核对4 |
| 初稿 / 最终字数 | 1,409 / 1,484 | 7,320 / 7,339 |
| 最终章节 / 局部修订 | 3章 / 5处 | 4章 / 5处 |
| 服务端保存完成 | 102.763秒 | 135.859秒 |
| 环境 | Node v22.15.0，darwin arm64；真实本地Wrangler/workerd、SQLite | 同左 |
| 运行结果 | 入口退出码0，最终保存回读一致 | 同左 |

两例均使用 `gemini-4-hydrogen`，提取 `low`、生成与核对 `high`，没有整篇重写或5W1H请求。每例目录保留8份原始运行产物，共用 [第二轮审阅记录](evidence/content-revalidation/round2/audit.md)：[V13初稿](evidence/content-revalidation/round2/V13/draft.md)、[最终稿](evidence/content-revalidation/round2/V13/article.md)、[修订](evidence/content-revalidation/round2/V13/revisions.json)、[请求及保存回读](evidence/content-revalidation/round2/V13/provenance.json)；[V15初稿](evidence/content-revalidation/round2/V15/draft.md)、[最终稿](evidence/content-revalidation/round2/V15/article.md)、[修订](evidence/content-revalidation/round2/V15/revisions.json)、[请求及保存回读](evidence/content-revalidation/round2/V15/provenance.json)。

经济案例恢复了周期的“约”“通常”语气，并拆开违约引发挤兑与债务重组的通缩影响；讲者模板和经验建议仍有归属，三章及1500字约束通过。但金额处仍未就近说明是视频所述数字，税收再分配后又直接接“易激化社会与国家间矛盾”，重复引入首轮已修过的因果越界。另一处写了“视频举例”，不等于金额处已有来源限定。降息条件、政府债务同时增加及接近零利率的表述精度继续作为审阅边界记录，不把普通省略一律写成相反事实。

SQL案例对“五年”与“2018至2023”、4.932与4.392均明确提示口径不一致、未作统一；ANSI保留推测语气，Vinayak、Tayas与Carter的问答归属正确。COUNT的78行、76个非空值、33家不同出版社，MAX/MIN按字母而非长度，`.quit`非SQL关键字，以及严格大于4.0／10000的边界均保留。五处修订没有误改列明正确锚点。该轮重点检查通过，仍不等于执行过全部SQL或证明所有视频稳定正确。

## 第三轮：整篇复核检出问题，仍未全部修复

第三轮两例流程成功，新增整篇语义限定复核确实执行。经济稿1421字、3章、4处修订、6次模型请求，保存完成107.422秒；SQL稿7393字、4章、5处修订、7次请求，保存完成176.076秒。两例均为Node v22.15.0、darwin arm64，模型请求均HTTP 200、STOP，无整篇重写或5W1H。详见 [第三轮审阅](evidence/content-revalidation/round3/audit.md)。

- 经济稿的金额来源、约数、讲者归属和降息条件已改善，但税收再分配仍被写成社会及国家间矛盾的原因。整篇模型已经检出并给出修订，却将字幕中的 `'have nots'.` 抄成 `'have nots.'`，生产证据校验以 `evidence_not_in_transcript` 正确拒绝。检出不等于采用，最终稿的问题没有关闭；没有因此放松证据守卫。后续加强最短充分证据与标点逐字复制。
- SQL稿保留ANSI不确定语气、两组来源冲突和COUNT等锚点，但把讲师为澄清问题而列举的AVG／COUNT／SUM挪进学生提问。这是发言边界变化，不能按提问压缩免责。后续增加通用“回答者的澄清不能补给提问者”规则。

## 第四轮：经济超限失败，SQL仍有来源边界问题

第四轮的 [完整审阅](evidence/content-revalidation/round4/audit.md)保留两种不同结果：

| 项目 | V13：经济笔记 | V15：SQL课程笔记 |
| --- | --- | --- |
| 模型请求 | 6次，均HTTP 200、STOP | 7次，均HTTP 200、STOP |
| 正文及结果 | 流式初稿1449字；根按模型建议复算修订后1511字，超出1500字上限 | 最终8166字、4章、7处实际修订 |
| 流程终点 | `requirements_unmet`，无 `done`、无 `revised`，没有成功保存回读 | `done`，保存回读与最终SSE一致，保存完成142.177秒 |
| 证据目录 | 7份失败产物，没有 `draft.md` | 8份原始运行产物 |

经济稿的整篇复核已提出正确的因果修订，证据也逐字匹配，第三轮的证据抄写问题得到处理。但补回限定后超限，保存前检查正确拒绝；不能放宽原上限或手改正文凑通过。[失败目录的article.md](evidence/content-revalidation/round4/V13/article.md)只是未完成流程保留的流式初稿，**不是最终文章**；`revisions.json`也没有已采用的记录。具体失败见 [时序](evidence/content-revalidation/round4/V13/timeline.json)及 [请求记录](evidence/content-revalidation/round4/V13/provenance.json)。

SQL稿修正了讲师澄清被挪入学生提问的问题，ANSI语气、来源冲突、COUNT等重点也保留；但第34行的 `sqlite>` 补入字幕没有口述的 `>`，约592票的例子只保留了约数而丢失假设性质。末尾将先肯定再说“I think I mistyped”的回答压成直接原因，也保留为问答及确定程度风险。不能借SQL常识或屏幕惯用形式补足来源。后续通用规则进一步区分约数与假设、限制未口述符号；第四轮原稿没有被手改。见 [SQL最终稿](evidence/content-revalidation/round4/V15/article.md)及 [修订](evidence/content-revalidation/round4/V15/revisions.json)。

## 当前机制与已完成工程检查

第二轮经济案例表明，仅收紧原有逐章提示仍会漏掉语义限定。当前收尾增加一次聚焦来源、确定程度、冲突和因果的整篇复核，与逐章核对并行；总连接上限仍为6，其中章节组最多5组，为整篇复核预留1个连接。先合并逐章修订，再应用整篇建议；逐章已替换的旧引文若不再唯一匹配，将由同一定位校验拒绝，不覆盖已改好的内容。字幕依据、结构和最终字数检查继续生效。

生成提示将初稿篇幅预算设为上限的七成左右。第四轮失败后，程序又增加核对前的篇幅预留：有用户字数上限，且初稿超过 `max(用户下限, floor(用户上限 × 0.8))` 时，复用原有至多一次整篇改写，与真正违反用户约束的情况共用一次预算。`review_headroom`只是内部压缩目标，改写后仍按用户原约束判断合格，不把八成目标变成新的硬性上限，也不截断正文。

如果初稿没有真正违反用户要求，`rewritten.unmet`保持空数组；页面中性显示“正在修订初稿”，修订记录说明“为后续字幕核对预留篇幅”，不虚报用户要求未满足。篇幅不足时减少次要细节，不靠删除来源、条件或假设语气压缩。最新符号、假设边界及篇幅预留的真实模型效果仍待验证。

| 已完成检查 | 实际输出 |
| --- | --- |
| 第一次通用提示修订的定向单测 | [77项通过](evidence/content-revalidation/rules-validation.log) |
| 增加整篇复核后的定向单测 | [87项通过](evidence/content-revalidation/focused-unit-validation.log) |
| 增加整篇复核阶段的Worker功能检查 | [2文件41项通过](evidence/content-revalidation/focused-worker-validation.log)，包含整篇复核协议失败及逐章成功仍不得保存的路径 |
| 增加整篇复核阶段的HTTP回归 | [8项通过](evidence/content-revalidation/focused-http-validation.log) |
| 最新篇幅预留版本的单元及前端功能检查 | [6文件214项通过](evidence/content-revalidation/headroom-unit-ui-validation.log)，其中后端4文件184项 |
| 最新Worker功能检查 | [3文件52项通过](evidence/content-revalidation/headroom-worker-validation.log) |
| 最新本地HTTP回归 | [8项通过](evidence/content-revalidation/headroom-http-validation.log) |
| 最新受控全栈浏览器 | [5项通过](evidence/content-revalidation/headroom-browser-validation.log)，真实Chromium、Wrangler/workerd和SQLite，模型与YouTube上游为本地替身 |
| Worker、客户端、Node三配置类型检查 | [全部通过](evidence/content-revalidation/headroom-typecheck-validation.log) |

以上为不同版本的定向结果，不相加冒充一轮全量测试。增加整篇复核时，首次Worker有5项失败、HTTP有3项失败，原因是旧断言中的请求数与取消数未更新；[Worker](evidence/content-revalidation/focused-worker-initial-failure.log)与 [HTTP](evidence/content-revalidation/focused-http-initial-failure.log)失败输出保留。增加篇幅预留后，Worker首次仅有1条旧断言仍预期2个请求，改为3个后52项通过，[首次输出](evidence/content-revalidation/headroom-worker-initial-failure.log)保留。

浏览器的 [项目参数错误](evidence/content-revalidation/headroom-browser-cli-error.log)及 [PATH缺少tsx](evidence/content-revalidation/headroom-browser-start-error.log)两次启动均未进入用例；5项通过来自修正运行入口后的实际执行。功能测试输出中的 `disk full` 是保存失败用例的故意注入，该用例通过，不表示实际磁盘异常。上述工程通过不能替代真实模型内容复验。

## 第五轮：账户预付额度耗尽，未产出正文

最新规则下两例入口均退出1，每例只有要求提取与文章生成两次官方请求，全部HTTP 402。响应明确是预付额度耗尽；SSE为 `gemini_billing`、`partial: false`，没有 `delta`、`revised`或 `done`。两例的 `article.md`均为空占位文件，没有 `draft.md`和保存回读，不能当作成功文章或语义通过证据。失败请求和时序保留在 [V13记录](evidence/content-revalidation/round5/V13/provenance.json)、[V13时序](evidence/content-revalidation/round5/V13/timeline.json)、[V15记录](evidence/content-revalidation/round5/V15/provenance.json)及 [V15时序](evidence/content-revalidation/round5/V15/timeline.json)。

第五轮没有检验到最新规则的内容效果，不能用第四轮SQL的部分改善、单元测试或模拟浏览器结果补作证明。当前代码、原始证据和文档已同步源工作树并核对字节一致；审查包更新仍待后续任务。现有审查包还是上一阶段交付，不能代表本轮新增规则和模型结果。

后续真实复验需要同一Gemini账户的预付额度恢复。本轮不自动付费、不更换凭据，也不继续重复失败请求。额度恢复后，仍需另存两例真实产物，对照字幕核对待改项及正确事实，再决定内容验收是否完成。

## 继续执行时的单次账户可用性检查

2026-11-26 04:49:07 UTC，以同一源工作树的现有凭据和生产模型 `gemini-4-hydrogen`（`high`）向固定 Google 官方接口发送一次最小请求，输出上限为128 token。实际241毫秒返回 HTTP 402 / `RESOURCE_EXHAUSTED`，错误明确提示预付额度已耗尽。没有重试、备用切换、充值或更换凭据；本次没有运行完整案例或重复工程测试。

[脱敏可用性记录](evidence/content-revalidation/availability-check.json)已同步源工作树，包含时间、模型、状态、生产配置摘要和实际运行环境（Node v26.9.0，darwin arm64），不含密钥、请求头或授权信息。本次仅为账户可用性取证，不是第六轮内容复验，也不改变两例最终内容效果未验证的结论。账户恢复可用后，仍须在新目录运行两例完整真实流程；本轮不再重复探测。

## 历史版本如何复核

首轮提示保存在 [首轮代码快照](evidence/content-revalidation/first-round-code/manifest.json)；后续分别保留 [第二轮](evidence/content-revalidation/round2/code/manifest.json)、[第三轮](evidence/content-revalidation/round3/code/manifest.json)及 [第四轮](evidence/content-revalidation/round4/code/manifest.json)源码快照，第四轮包含提示、核对、收尾、要求处理、共享类型和并行预算六个模块。快照保留当轮原始字节及摘要，不随后续实现更新；它们是相关变更文件的快照，不是完整Git历史或全部旧测试环境。

复核首轮、第二轮或 [此前受控验收](CODEX_VALIDATION.md)时，应按对应记录中的摘要和保留版本判断。旧记录绑定的源码摘要不再等于当前实现，是这次有证据的版本演进，不应误写为历史运行期间发生漂移；也不能把新版本测试结果倒填为旧版本执行结果。

## 证据与后续验收边界

成功轮次保留原始输入、客户端SSE、初稿、最终稿、修订、时序、执行日志、模型请求及保存回读，并配有字幕审阅记录。失败轮次只保留实际收到的流式内容和错误，不补造最终稿；第四轮经济稿及第五轮两例的文件含义已在上文区分。首轮两例各9份文件已同步源工作树并核对字节一致。交付记录中的实际凭据值与密钥模式扫描未命中；入口临时配置、令牌、存储和进程已清理，正式原始产物保留。

历史线上文章仍在源项目根目录 `evidence/final2/online-cases-2/`，已存字幕仍在 `evidence/additional/preflight/`，没有被本轮文章替换。没有部署、push或修改线上数据，也没有声称生产环境已包含本轮规则。

[此前受控验收](CODEX_VALIDATION.md)的8项HTTP、4项浏览器及类型检查保留为历史工程证据；最新篇幅预留版本另有上表5项受控浏览器结果。两组的模型上游都是模拟的，不能替代真实模型内容验收。真实模型案例本身未在浏览器或线上运行，也不能扩大为这些边界的新证明。

通用规则修正不使用视频ID或专用答案特判。各轮均另存产物，所有已完成及失败轮次保留，不能手改后当成新结果。

当前整体验收仍未完成：最终规则的工程已验证，真实模型内容效果未验证，账户预付额度恢复是继续真实复验的外部条件；源证据与文档交付已完成，审查包更新仍需完成。单样本运行成功、约束通过或采用有效修订，都不能证明所有视频的内容稳定正确。

本轮输入/历史源码绑定、原始流与保存回读、实际测试及阻塞汇总见[轻量验证记录](evidence/content-revalidation/validation.json)。
