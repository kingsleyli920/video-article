# CS50 SQL 第 0 课笔记：查询（Querying）

## 查询：数据库概念、SQLite 与 SELECT 基础

### 数据库与 DBMS 基础概念
- 讲师 Carter Zenke 在课程《CS50's Introduction to Databases with SQL》开篇指出，信息时代每天都在产生大量数据（如 Google 记录点击和搜索的网站、手机或手表记录的健康信息与消息、YouTube 记录的视频与评论），本课将学习如何表示、组织、管理并向数据提问。
- 表（table）：如同几千年前记录神庙工人津贴的图表，表用于存储一组信息，每一行（row）代表集合中的一个条目，每一列（column）代表该条目的一项属性。例如图书馆整理书目时，每行对应一本书（如 Toni Morrison 所著《Song of Solomon》、Margaret Wise Brown 所著《Goodnight Moon》），两列分别为书名（title）和作者（author）。
- 相比电子表格软件（如 Apple Numbers、Google Sheets、Microsoft Excel），转向数据库主要有三个原因：
  1. 规模：Google 或 Instagram 等应用需要存储数百万甚至数十亿用户的数据，数据库更适合承载此类规模。
  2. 更新频率：如 Twitter 上用户每秒发送多条推文，数据库比电子表格更能胜任高频数据更新。
  3. 检索速度：电子表格中使用 Command-F 或 Control-F 只能逐行查找，而数据库提供更多搜索算法，能显著提升查询速度。
- 数据库与数据库管理系统（DBMS）：数据库是一种组织数据的方式，支持创建（create）、更新（update）、读取（read）和删除（delete）数据。DBMS 是用于与数据库交互的软件（可通过图形界面或文本语言操作），课堂举例包括 MySQL、Oracle、PostgreSQL、SQLite，以及学生提到的 Microsoft Access 和 MongoDB。
- 选择 DBMS 时的权衡：
  1. 专有软件与开源/免费软件：专有软件需要付费，但能获得实施数据库的额外支持；开源或免费软件（如 PostgreSQL、MySQL、SQLite）则需由使用者自行负责实施。
  2. 重量级与轻量级：MySQL 和 PostgreSQL 功能更全面，但相对更重、需要更多计算资源；SQLite 更轻量，但能完成大部分相同的工作。本课程先使用 SQLite，后续逐步过渡到 MySQL 和 PostgreSQL。SQLite 也广泛应用于内存较低的手机应用、桌面应用以及存储网页表单提交的数据。
- SQL 的含义：Structured Query Language（结构化查询语言），是一种带有关键字的结构化语言，可用于向数据库提问（查询），也可用于创建、读取、更新和删除数据。现实中可用它回答诸如 Instagram 或 Facebook 哪类帖子获赞最多、初创公司日活用户是在增长还是萎缩、Spotify 如何推荐相似歌曲等问题。

### 工具准备与课程数据集
- 本课在 Visual Studio Code（简称 VS Code，集成开发环境）的终端中使用 SQLite（DBMS）。
- 课程数据集 `longlist.db` 存储国际布克奖（International Booker Prize，授予世界各国作家虚构类作品的奖项）的入围长名单书籍。关于数据范围，讲师先说明评委每年选出 13 本书、数据库包含“五年”的入围名单，随后在回答提问时说明数据涵盖 2018 至 2023 年，后文查询总行数时返回 78 本（字幕前后口径不一致，未作统一）。
- 打开环境与基本操作：
  1. 输入 `ls` 查看当前目录中的文件，可看到 `longlist.db`。
  2. 运行 `sqlite3 longlist.db`（SQLite 第 3 版软件）打开数据库，终端提示符由 `$` 变为 `sqlite`。
  3. 按 `Control-L` 可清空终端屏幕。

### 使用 SELECT 与 LIMIT 查询数据
- 查询所有列与所有行：`SELECT * FROM "longlist";`。`*` 表示全部行与全部列，分号 `;` 表示查询结束。
- 查询指定列：
  1. 查询单列书名：`SELECT "title" FROM "longlist";`。
  2. 查询多列：可用逗号分隔多个列名。讲师首次演示时口述选择 `title` 和 `authors`（后文其余查询均口述为 `author`，字幕列名口径略有不一致，未作统一）。
- 限制返回行数（`LIMIT`）：面对包含大量数据的表，可用 `LIMIT` 预览前几条记录，返回顺序为数据写入表的顺序。
  1. `SELECT "title" FROM "longlist" LIMIT 10;` 仅返回前 10 行书名。
  2. `SELECT "title" FROM "longlist" LIMIT 5;` 仅返回前 5 行书名。

### 课堂问答：引号、数据来源与大小写
- **学生:** 必须像演示中那样给词加上引号吗？
  **Carter Zenke:** 在表名和列名（称为 SQL 标识符）外加双引号是良好的书写习惯。后续还会用到字符串（字符集合），届时会用单引号包裹字符串，以区分字符串与列名。
- **学生:** 这份书单的数据来自哪里？
  **Carter Zenke:** 数据整合自多个公开来源：2018 至 2023 年的入围书籍来自布克奖官网，而书籍评分和投票数来自在线书评聚合网站 Goodreads。
- **Vinayak:** SQLite 3 是否区分大小写？演示时语法用了大写字母，能否改用小写？
  **Carter Zenke:** 演示运行小写的 `select title from longlist;` 同样能执行，但不建议这么做。将 SQL 关键字大写、表名和列名小写是更好的代码风格，尤其在长查询中能让读者分清哪些是 SQL 关键字、哪些是标识符。

## 筛选：WHERE 条件、空值与模糊匹配

### WHERE 基本条件与否定写法
- `WHERE` 用于筛选行，只返回满足指定条件的结果。
- 相等条件（`=`）：`SELECT "title", "author" FROM "longlist" WHERE "year" = 2023;` 返回 2023 年提名的书籍。因 `2023` 是整数，无需加引号；演示中也同样查询了 `2022` 年和 `2021` 年。
- 不等条件（`!=`、`<>`、`NOT`）：
  1. `SELECT "title", "format" FROM "longlist" WHERE "format" != 'hardcover';` 过滤掉精装本（`'hardcover'` 为字符串，使用单引号），结果仅剩平装本（paperback）。
  2. 将 `!=` 换成 `<>` 效果相同，但 `!=` 更常见。
  3. 也可在 `WHERE` 后使用关键字 `NOT` 对条件取反，例如对 `"format"` 等于 `'hardcover'` 取反，结果完全一致。

### 组合条件与括号优先级
- 使用 `AND`、`OR` 可将多个条件连接成复合条件，括号 `()` 用于标明先执行括号内的条件。长查询在输入分号 `;` 前可以换行书写。
- 筛选多个年份：`SELECT "title", "author" FROM "longlist" WHERE "year" = 2022 OR "year" = 2023;` 返回 2022 年或 2023 年提名的书籍。
- 括号与多条件组合：在查询 `"title"` 和 `"format"` 时，结合 `WHERE ("year" = 2022 OR "year" = 2023)` 以及 `"format"` 不等于 `'hardcover'` 的条件，只返回 2022 和 2023 年的平装书。

### 缺失值判断：NULL、IS NULL 与 IS NOT NULL
- `NULL` 表示该值在数据库中不存在或缺失（如部分入围书籍原本就是英文或没有单独译者）。
- 查找没有译者记录的书：`SELECT "title", "translator" FROM "longlist" WHERE "translator" IS NULL;` 返回 2 本书（《The Perfect Nine》等），其译者列为空。
- 查找有译者记录的书：`SELECT "title", "translator" FROM "longlist" WHERE "translator" IS NOT NULL;` 返回所有存在译者的书籍。

### 模糊匹配：LIKE、% 与 _
- `LIKE` 用于对字符串进行近似模式匹配，配合两个通配符使用：
  1. `%` 匹配任意数量的字符：
     - `SELECT "title" FROM "longlist" WHERE "title" LIKE '%love%';` 返回书名任意位置包含 `love` 的 4 本书（包括《Love in the Big City》《More Than I Love My Life》等）。
     - `SELECT "title" FROM "longlist" WHERE "title" LIKE 'The%';` 查找以 `The` 开头的书名（演示时讲师先误用了双引号，随后修正为单引号）。讲师指出 `'The%'` 理论上也会匹配 `There` 或 `They` 等词，更严谨的设计应写成 `'The %'`（`The` 后带空格）。
  2. `_` 匹配任意单个字符：
     - 若不确定《Pyre》的第二个字母是 `i` 还是 `y`，可用 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'P_re';` 查出《Pyre》。

### 范围筛选：比较运算符与 BETWEEN
- 当需要筛选连续区间（如 2019 至 2022 年）时，相比连写多个 `OR`，范围写法更简洁：
  1. 比较运算符（`>`、`<`、`>=`、`<=`）：`SELECT "title", "year" FROM "longlist" WHERE "year" >= 2019 AND "year" <= 2022;`。
  2. `BETWEEN ... AND ...`（包含边界值）：`SELECT "title", "year" FROM "longlist" WHERE "year" BETWEEN 2019 AND 2022;` 返回相同结果。
- 筛选评分、投票数与页数：
  1. 讲师提出查找评分“4.0 及以上”的书籍，口述演示的代码使用了严格大于号：`SELECT "title", "rating" FROM "longlist" WHERE "rating" > 4.0;`。
  2. 结合投票数筛选高分热门书：`SELECT "title", "rating", "votes" FROM "longlist" WHERE "rating" > 4.0 AND "votes" > 10000;` 返回 4 本书。
  3. 按页数筛选：`SELECT "title", "pages" FROM "longlist" WHERE "pages" < 300;` 返回首次出版时少于 300 页的书籍。

### 课堂问答：SQL 子集、通配符组合与数据类型
- **学生:** 为什么存在不同的 SQL 子集？
  **Carter Zenke:** SQL 语言由标准机构 ANSI 定义官方版本，不同数据库管理系统会使用其中的某个子集，例如 SQLite、PostgreSQL 和 MySQL 各自支持对应的 SQL 子集。
- **Tayas:** 能否在终端中同时筛选 2022 年和 2021 年？
  **Carter Zenke:** 可以，随后课程中演示了如何在 `WHERE` 中结合多个条件实现。
- **学生:** 我们如何预先知道表中有 `title` 和 `author` 这些列名？
  **Carter Zenke:** 后续课程会讲解如何查看数据库的模式（schema）以了解表结构与列名；本节课因讲师事先构建了数据库，所以已知道列名。
- **学生:** 能否在两个词之间使用两个 `%`？
  **Carter Zenke:** 可以。演示了 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'The%love%';`（以 `The` 开头并在后文中包含 `love`），结果本数据库中没有符合该条件的书。
- **学生:** 能否使用多个 `_` 来匹配多个字符？
  **Carter Zenke:** 可以。演示 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'T___';`（`T` 后跟 3 个下划线）返回了《Tyll》；又演示 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'Ty____';`（`Ty` 后跟 4 个下划线），返回无匹配结果。
- **学生:** （1）做范围运算的列在数据库中必须是整数吗？（2）匹配字符串时是否区分大小写？
  **Carter Zenke:** （1）这取决于数据库设计时的列类型（课程后续会讲解如何选择列类型）；在本数据库中，`year` 和 `votes` 为整数，`rating` 为实数或浮点数。（2）`=` 区分大小写，例如 `SELECT "title" FROM "longlist" WHERE "title" = 'pyre';` 返回空；而 `LIKE` 不区分大小写，`SELECT "title" FROM "longlist" WHERE "title" LIKE 'pyre';` 能返回《Pyre》。

## 排序：ORDER BY 与多列排序

### 升序（ASC）与降序（DESC）
- `ORDER BY` 用于按指定列对查询结果进行排序，默认按升序（`ASC`，即从小到大或按字母表正序）排列。
- 默认升序：`SELECT "title", "rating" FROM "longlist" ORDER BY "rating" LIMIT 10;` 返回评分最低的前 10 本书（如 3.05、3.42 等）。
- 指定降序（`DESC`，从大到小）：`SELECT "title", "rating" FROM "longlist" ORDER BY "rating" DESC LIMIT 10;` 返回评分最高的前 10 本书，例如《The Eighth Life》（4.52）和《The Books of Jacob》（4.06）。

### 多列排序打破平局
- 在评分前 10 的结果中，《Still Born》与《When We Cease to Understand the World》的评分同为 4.14。
- 在 `ORDER BY` 后用逗号分隔多个排序列，可先按 `rating` 降序、再按 `votes` 降序打破平局：`SELECT "title", "rating", "votes" FROM "longlist" ORDER BY "rating" DESC, "votes" DESC LIMIT 10;`。结果显示《When We Cease to Understand the World》因投票数更多而排在更前面。

### 课堂问答：特定评分查询与文本排序
- **学生:** 能否写条件把评分查到 4.93 到 4.9？
  **Carter Zenke:** 讲师理解其意为查询某一特定评分，演示了 `SELECT "title", "rating" FROM "longlist" WHERE "rating" = 4.932;`（后文口述结果时说成 4.392，字幕前后数字不一致，未作统一），结果没有匹配的书籍。
- **学生:** `DESC` 对字符串会按字母表排序吗，还是需要特殊条件？
  **Carter Zenke:** 可以直接用于文本。演示 `SELECT "title" FROM "longlist" ORDER BY "title";` 默认按字母表正序排列；`SELECT "title" FROM "longlist" ORDER BY "title" DESC;` 则按字母表逆序排列。

## 聚合：统计函数、去重与退出

### 聚合函数基础：AVG、MAX、MIN、SUM
- 聚合函数（aggregate functions）把多行数据汇总并计算为单个结果。
- `AVG`（求平均值）：`SELECT AVG("rating") FROM "longlist";` 返回所有书籍的平均评分 `3.7537179471795`。
- `ROUND`（四舍五入）与 `AS`（重命名列）：
  1. `SELECT ROUND(AVG("rating"), 2) FROM "longlist";` 接受两个参数（待舍入数值与小数位数），将平均分保留两位小数，返回 `3.75`。
  2. `SELECT ROUND(AVG("rating"), 2) AS "average rating" FROM "longlist";` 用 `AS` 将输出结果的列名由复杂的函数写法重命名为 `average rating`。
- `MAX`（最大值）与 `MIN`（最小值）：
  1. `SELECT MAX("rating") FROM "longlist";` 返回最高评分 `4.52`。
  2. `SELECT MIN("rating") FROM "longlist";` 返回最低评分 `3.05`。
- `SUM`（求和）：`SELECT SUM("votes") FROM "longlist";` 计算所有书籍的总投票数，结果超过 60 万。

### 计数与去重：COUNT 与 DISTINCT
- `COUNT(*)` 统计表中的全部行数：`SELECT COUNT(*) FROM "longlist";` 返回 `78`。
- `COUNT(列名)` 仅统计该列中非 `NULL` 的记录数：`SELECT COUNT("translator") FROM "longlist";`（讲师先口述为 `translators`，后文口述为 `translator`）返回 `76`，因为有 2 本书的译者为 `NULL`。
- `DISTINCT` 去除重复值：直接执行 `SELECT "publisher" FROM "longlist";` 会发现部分出版商名称重复出现（如 Harvill Secker 和 MacLehose Press）。演示中讲师先误拼为 `SELECT "pubsliher" FROM "longlist";`，因该列不存在，SQLite 直接按拼写输出了对应数据；修正拼写后使用 `SELECT DISTINCT "publisher" FROM "longlist";` 获取不重复的出版商列表，再用 `SELECT COUNT(DISTINCT "publisher") FROM "longlist";` 统计出共有 `33` 家不同的出版商。

### 退出 SQLite 与课程小结
- 退出提示符：输入 `.quit` 可退出 SQLite 返回终端；`.quit` 属于 SQLite 命令，而非 SQL 关键字。
- 本课围绕单表介绍了 `SELECT`、聚合函数、`WHERE` 条件筛选、`ORDER BY` 排序及 `LIMIT` 限制行数等查询基础；下一课将介绍如何把书籍、出版商与作者拆分到多张表中以表达实体之间的关系。

### 课堂问答：聚合函数命名与字符串极值
- **学生:** `AVG`、`COUNT`、`SUM` 这类命令有专门的名称吗？
  **Carter Zenke:** 它们叫做聚合函数（aggregate functions），因为它们将多行数据合并、聚合成单一单元格的值。
- **学生:** `MAX` 和 `MIN` 函数能否用来查找最长或最短的字符串？
  **Carter Zenke:** 演示 `SELECT MAX("title"), MIN("title") FROM "longlist";` 后，返回 `Wretchedness`（`MAX`）和 `A New Name: Septology VI-VII`（`MIN`）。`MAX` 返回的书名反而更短，说明它们不比较字符串长度，而是按字母表顺序比较：`MIN` 返回字母表最靠前的书名（`A` 开头），`MAX` 返回字母表最靠后的书名（`W` 开头）。