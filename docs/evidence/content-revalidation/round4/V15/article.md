# CS50 SQL 第 0 讲课程笔记：Querying（查询）

## 查询：数据库概念与 SELECT 基础

### 课程目标与数据表的概念

讲师 Carter Zenke 在课程开篇介绍，这门课（CS50's Introduction to Databases with SQL）旨在帮助学习者掌握如何表示、组织、管理并向日常生活中的数据提问。讲师举例提到，在信息时代，例如 Google 可能记录用户点击和搜索的网站，智能手机与智能手表可能追踪健康信息、邮件和短信，YouTube 也可能记录平台上的视频、创作者乃至观众留下的评论。

虽然数据库和 SQL 是现代工具，但组织数据的核心概念历史悠久。课程展示了一张距今几千年前、记录神庙工人薪俸（stipends）的行列图表。Carter Zenke 在与听众互动后将其定义为“表（table）”：表用于存储一组信息，每一行（row）代表集合中的一个条目（例如一名工人），每一列（column）代表该条目的某项属性或信息（例如某个月份的薪俸）。以图书馆藏书为例，每本书占一行，书名（title）和作者（author）各占一列，例如 Toni Morrison 的《Song of Solomon》与 Margaret Wise Brown 的《Goodnight Moon》。

### 为什么需要数据库、DBMS 与 SQL

现代人不再需要用石板或纸笔记录表格，而是可以使用 Apple Numbers、Google Sheets 和 Microsoft Excel 等电子表格软件。讲师提出，相比电子表格，数据库可能具备以下优势：

1. 数据规模（scale）：面对 Google 或 Instagram 级别的百万甚至数十亿级用户数据时，使用数据库可能更适合存储如此庞大的信息量。
2. 更新频率：面对类似 Twitter 每秒多次发帖的高频更新场景，数据库的承载能力远高于电子表格。
3. 查询速度（speed）：在电子表格中往往需要类似 Command-F 或 Control-F 那样逐行查找，而数据库提供多种算法，能更快地检索数据。

数据库（database）是组织数据的方式，支持创建（create）、读取（read）、更新（update）和删除（delete）四种基本交互。而用来与数据库交互的软件称为数据库管理系统（DBMS），可以通过图形界面或文本语言操作。常见 DBMS 包括 MySQL、Oracle、PostgreSQL、SQLite，以及课堂互动中提到的 Microsoft Access 和 MongoDB 等。选择软件时通常需要权衡：

1. 授权与支持：专有软件（proprietary）需要付费，但附带实施支持服务；开源或免费软件（如 PostgreSQL、MySQL、SQLite）则需由使用者自行负责部署实现。
2. 体量与资源消耗：MySQL 和 PostgreSQL 功能更全面但较重（heavier weight），需要更多计算资源；SQLite 如其名称所示更为轻量（lighter weight），但同样能完成大部分工作。本课程初期使用 SQLite，后续会逐步过渡到 MySQL 和 PostgreSQL。

SQL 全称为 Structured Query Language（结构化查询语言），是一种利用特定关键词向数据库提问并执行增删改查的语言。讲师举例称，借助 SQL 可以回答诸如“平台上最受点赞的帖子是什么”“初创公司的日活用户是在增长还是下降”或“如何向用户推荐与刚听过歌曲相似的曲目”等问题。

### 课程数据集、工具与基础查询

本讲使用的案例数据库围绕国际布克奖（International Booker Prize）入围长名单构建。讲师介绍委员会每年选出 13 本书列入长名单，随后先提到库中包含 5 年的名单，后又说明数据来自 2018 至 2023 年（字幕前后对年限口径不一致，未作统一）；数据整合了布克奖官网的公开书单与 Goodreads 上的读者评分及投票数。

操作工具采用集成开发环境 Visual Studio Code（简称 VS Code）与 SQLite。讲师同时提到，SQLite 不仅用于本课程，还常用于内存较低的手机应用、桌面应用以及网站表单数据存储。

在终端中进入工作环境与执行基础查询的命令及结果如下：

1. 查看文件与打开数据库：在终端输入 `ls` 可看到 `longlist.db`；输入 `sqlite3 longlist.db`（第 3 版 SQLite 软件）即可打开数据库，终端提示符由 `$` 变为 `sqlite>`，按 `Control-L` 可清屏。
2. 查询全表数据：`SELECT * FROM "longlist";`（口述中将 `*` 称为 star）。`*` 表示返回表中所有行和所有列，因终端窗口较小会一次性输出大量数据。
3. 查询指定列：`SELECT "title" FROM "longlist";` 仅返回 `title` 列；多列可用逗号分隔，如 `SELECT "title", "author" FROM "longlist";` 返回书名与作者两列。
4. 限制返回行数：`LIMIT` 用于限定查询返回的行数，适合在数据量大时预览数据集开头部分内容。例如 `SELECT "title" FROM "longlist" LIMIT 10;` 返回前 10 行，`SELECT "title" FROM "longlist" LIMIT 5;` 按记录写入顺序返回前 5 本书名。

### 课堂问答

- **学生:** 是否必须像讲师那样在单词两侧加上引号？
- **Carter Zenke:** 表名和列名属于 SQL 标识符（SQL identifiers），用双引号（double quotes）括起是良好的代码风格习惯；后续使用的字符串（strings，字符集合）则会用单引号（single quotes），用以区分字符串与列名。

- **学生:** 这个书籍清单的数据是从哪里获取的？
- **Carter Zenke:** 结合了多种公开来源。入围书单来自国际布克奖官网上的公开数据（此处讲师说明为 2018 至 2023 年），书籍评分与投票数则来自书评网站 Goodreads。

- **Vinayak:** 终端里的 `sqlite3` 语法是否区分大小写？讲师在写关键词时用了大写，能否也用小写？
- **Carter Zenke:** 现场演示执行 `select "title" from "longlist";` 同样能够正常运行。但将 SQL 关键词统一大写、表名和列名用小写是更好的风格规范，有助于他人在阅读长查询时清晰区分关键词与标识符。

## 筛选：用 WHERE 设定查询条件

### 相等、不等与取反条件

`WHERE` 关键词用于设定筛选条件，使查询只返回满足该条件的行。

1. 相等筛选（`=`）：`SELECT "title", "author" FROM "longlist" WHERE "year" = 2023;` 返回 2023 年入围的书名与作者（`2023` 是整数，无需加引号）。同理可将年份替换为 `2022` 或 `2021`。
2. 不等筛选（`!=` 与 `<>`）：若想排除精装版（hardcover）书籍，可写为 `SELECT "title", "format" FROM "longlist" WHERE "format" != 'hardcover';`（`hardcover` 为字符串，使用单引号），结果仅返回平装版（paperback）书籍。使用 `<>` 效果相同，即 `SELECT "title", "format" FROM "longlist" WHERE "format" <> 'hardcover';`，但 `!=` 更为常见。
3. 逻辑取反（`NOT`）：`SELECT "title", "format" FROM "longlist" WHERE NOT "format" = 'hardcover';` 会对等式条件取反，返回相同结果。

### 复合条件、空值与模糊匹配

1. 组合条件（`AND`、`OR` 与括号）：在输入未用分号结束的查询时，可换行继续编写。`SELECT "title", "author" FROM "longlist" WHERE "year" = 2022 OR "year" = 2023;` 返回 2022 或 2023 年的入围书籍。若需叠加格式限制，可用括号标明优先级：`SELECT "title", "format" FROM "longlist" WHERE ("year" = 2022 OR "year" = 2023) AND "format" != 'hardcover';`，返回这两年中的平装书。
2. 空值判断（`NULL`、`IS NULL`、`IS NOT NULL`）：`NULL` 表示该值在数据库中缺失。许多入围作品译自其他语言，但也有部分没有单独的译者。运行 `SELECT "title", "translator" FROM "longlist" WHERE "translator" IS NULL;` 返回了两本译者为空的书（字幕中提及《The Perfect Nine》以及原文听写为 the indictment of The Enlightenment of The Greengate Tree 的书名）。反之，运行 `SELECT "title", "translator" FROM "longlist" WHERE "translator" IS NOT NULL;` 会返回所有存在译者信息的记录。
3. 模式匹配（`LIKE`、`%` 与 `_`）：`LIKE` 用于粗略匹配字符串。`%` 可匹配任意数量（包括零个或多个）的任意字符，`_` 仅匹配单个任意字符。
   - 包含特定词：`SELECT "title" FROM "longlist" WHERE "title" LIKE '%love%';` 返回 4 本书名中包含 `"love"` 的书籍，如《Love in the Big City》和《More Than I Love My Life》。
   - 匹配开头：讲师演示查找以 `"The"` 开头的书名，最初输入时误用了双引号并主动纠偏改回单引号。运行 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'The%';` 虽然返回了以 `"The"` 开头的书，但讲师指出若库中有 `"There"` 或 `"They"` 开头的书名也会被意外匹配，因此在 `The` 后加空格写成 `'The %'` 更为严谨。
   - 匹配单个未知字符：查找不确定是 `Pire` 还是 `Pyre` 的书名时，运行 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'P_re';`，返回《Pyre》。

### 数值范围筛选

当需要筛选连续年份时，用多个 `OR` 连接（如 `year = 2019 OR year = 2020 OR year = 2021 OR year = 2022`）较为繁琐，可改用比较运算符（`>`、`<`、`>=`、`<=`）或 `BETWEEN ... AND ...`：

1. 比较运算符范围：`SELECT "title", "year" FROM "longlist" WHERE "year" >= 2019 AND "year" <= 2022;` 返回 2019 至 2022 年的书籍。
2. 区间关键词 `BETWEEN`：`SELECT "title", "year" FROM "longlist" WHERE "year" BETWEEN 2019 AND 2022;` 效果完全相同，且包含 `2019` 和 `2022` 两个边界值。
3. 评分、投票数与页数筛选：`SELECT "title", "rating" FROM "longlist" WHERE "rating" > 4.0;` 筛选评分高于 4.0 的书；叠加条件 `SELECT "title", "rating", "votes" FROM "longlist" WHERE "rating" > 4.0 AND "votes" > 10000;` 筛选出 4 本评分高于 4.0 且投票数超过 10000 的书；`SELECT "title", "pages" FROM "longlist" WHERE "pages" < 300;` 则筛选首次出版时少于 300 页的书。

### 课堂问答

- **学生:** SQL 是否有不同的子集（subsets）？
- **Carter Zenke:** 是的。SQL 由标准组织（讲师提到印象中是 ANSI）制定官方规范，而各个数据库管理系统（如 SQLite、PostgreSQL、MySQL）会各自采用并支持其中的一部分子集。

- **Tayas:** 能否在终端中同时筛选 2022 年和 2021 年的数据？
- **Carter Zenke:** 可以，并在接下来的演示中讲解了使用 `OR` 等方式组合多个筛选条件的方法。

- **学生:** 在写查询时，怎么知道表里有哪些可用的列名（如 `title` 和 `author`）？
- **Carter Zenke:** 后续课程会讲解如何查看数据库的模式（schema）来获取表内的列信息；本讲中是讲师预先知道该表的列名后直接用于演示的。

- **学生:** 能否在两个词之间使用两个 `%` 符号？
- **Carter Zenke:** 可以。讲师运行 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'The%love%';` 演示如何匹配以 `"The"` 开头且后续包含 `"love"` 的书名；该库中没有符合此描述的书，因此未返回结果。

- **学生:** 能否使用多个 `_` 来匹配多个字符？
- **Carter Zenke:** 完全可以。讲师以《Tyll》为例，先运行 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'T___';`（`T` 后跟 3 个下划线）成功匹配到了《Tyll》；随后测试在 `TY` 后加上多个下划线（如 4 个下划线），则未返回匹配结果。

- **学生:** 进行范围或比较运算时列值是否必须是整数？另外，字符串匹配是否区分大小写？
- **Carter Zenke:** 列的数据类型取决于数据库设计，后续课程会讲如何指定类型；当前 `longlist` 表中，`year` 和 `votes` 为整数，`rating` 为实数或浮点数（real number / float）。关于大小写，现场对比验证显示：`SELECT "title" FROM "longlist" WHERE "title" LIKE 'pyre';` 返回了 `Pyre`（`LIKE` 不区分大小写），而 `SELECT "title" FROM "longlist" WHERE "title" = 'pyre';` 返回空结果（`=` 区分大小写）。

## 排序：用 ORDER BY 整理结果

### 升序、降序与多列排序

`ORDER BY` 用于对查询返回的行进行排序：

1. 默认升序（`ASC`）：运行 `SELECT "title", "rating" FROM "longlist" ORDER BY "rating" LIMIT 10;` 后，返回结果排在前面的评分为 `3.05` 到 `3.42`。这说明 `ORDER BY` 默认按升序（`ASC`，从最小到最大）排序。
2. 指定降序（`DESC`）：若要查看评分最高的 10 本书，需加上 `DESC`（从最大到最小），即 `SELECT "title", "rating" FROM "longlist" ORDER BY "rating" DESC LIMIT 10;`。结果中最高分为 `4.52`（《The Eighth Life》），第 10 项为 `4.06`（《The Books of Jacob》）。
3. 多列排序打破平局：在按评分降序的结果中，《Still Born》与《When We Cease to Understand the World》的评分同为 `4.14`。为此可在 `ORDER BY` 中按先后顺序指定多列：`SELECT "title", "rating", "votes" FROM "longlist" ORDER BY "rating" DESC, "votes" DESC LIMIT 10;`。结果先按 `rating` 降序排列，评分相同时再按 `votes` 降序排列，从而将投票数更多的《When We Cease to Understand the World》排在前面。

### 课堂问答

- **学生:** 能否把评分写成 `4.93 to 4.9` 这样来查询？
- **Carter Zenke:** 如果是要查找等于某一具体评分的书籍，可以用 `WHERE "rating" = ...` 进行筛选。讲师在转述问题和演示精确匹配时，先后说出 `4.92`、`4.932` 与 `4.392`（字幕前后口径不一致，未作统一），由于库中没有对应评分的书籍，查询未返回结果。

- **学生:** `DESC` 能否按字母顺序对字符串排序，还是需要特殊条件？
- **Carter Zenke:** 可以直接用于文本列。讲师运行 `SELECT "title" FROM "longlist" ORDER BY "title";` 验证默认会按字母升序排列；改用 `SELECT "title" FROM "longlist" ORDER BY "title" DESC;` 则会按逆字母顺序排列。

## 聚合：统计汇总与课程总结

### 常用聚合函数、四舍五入与别名

SQL 的聚合函数（aggregate functions）能够将多行数据汇总并计算为单个数值：

1. 求平均值（`AVG`）、四舍五入（`ROUND`）与别名（`AS`）：
   - `SELECT AVG("rating") FROM "longlist";` 返回所有书籍的平均评分 `3.7537179471795`。
   - 为改善显示效果，用 `ROUND` 保留两位小数：`SELECT ROUND(AVG("rating"), 2) FROM "longlist";`，结果为 `3.75`。
   - 为避免结果表头显示冗长的函数名，可用 `AS` 为结果列重命名：`SELECT ROUND(AVG("rating"), 2) AS "average rating" FROM "longlist";`。
2. 最大值（`MAX`）与最小值（`MIN`）：
   - `SELECT MAX("rating") FROM "longlist";` 返回最高评分 `4.52`。
   - `SELECT MIN("rating") FROM "longlist";` 返回最低评分 `3.05`。
3. 求和（`SUM`）：先通过 `SELECT "title", "votes" FROM "longlist";` 查看各书获得的投票（例如《Go, Went, Gone》约有 592 票），再运行 `SELECT SUM("votes") FROM "longlist";`，结果显示总投票数超过 60 万（over 600,000）。

### 计数、空值处理与去重

1. 统计行数（`COUNT`）：
   - `SELECT COUNT(*) FROM "longlist";` 统计全表总行数，返回 `78` 本书。
   - `SELECT COUNT("translator") FROM "longlist";` 返回 `76`。讲师解释，`COUNT(*)` 统计所有行，而 `COUNT` 指定具体列名时仅统计非 `NULL` 的记录（有 2 本书的译者为 `NULL`）。
2. 去重统计（`DISTINCT`）：
   - 运行 `SELECT "publisher" FROM "longlist";` 可看到多家出版社重复出现（如 `Harvill Secker` 和 `MacLehose Press` 均出现多次），因此直接用 `COUNT("publisher")` 会重复计数。
   - 使用 `DISTINCT` 可筛选唯一值：`SELECT DISTINCT "publisher" FROM "longlist";` 会过滤掉重复的出版社名称。
   - 结合 `COUNT` 与 `DISTINCT` 运行 `SELECT COUNT(DISTINCT "publisher") FROM "longlist";`，最终得出共有 `33` 家不同的出版社。

### 退出环境与课程总结

若要退出 SQLite 命令行环境，可输入 `.quit`（这是 SQLite 的专有命令，而非 SQL 关键词）。

讲师总结本讲已掌握的核心查询结构：`SELECT` 选取列、聚合函数汇总数据、`FROM` 指定表、`WHERE` 结合条件（包括 `=`、`LIKE`、`AND`、`OR` 等）筛选行、`ORDER BY` 排序以及 `LIMIT` 限制输出行数。下一讲将进一步学习如何把单张书籍表拆分为多张表，以表示书籍、出版商和作者等不同实体之间的关系。

### 课堂问答

- **学生:** 这类命令是否有专门的名称？
- **Carter Zenke:** 它们统称为聚合函数（aggregate functions），“聚合”意为组合与汇总，即将多行数据（例如全部评分）归约为单个单元格中的统计结果。

- **学生:** `MAX` 和 `MIN` 函数能否用于查找最长或最短的字符串，还是有其他专门命令？
- **Carter Zenke:** 讲师运行 `SELECT MAX("title"), MIN("title") FROM "longlist";` 进行测试，分别返回了 `Wretchedness`（MAX）和 `A New Name-- Septology VI-VII`（MIN）。讲师由此推测，`MAX` 和 `MIN` 对字符串可能并非比较长度，而似乎是按字母顺序比较：`MIN` 返回字母序最靠前（以 A 开头）的书名，`MAX` 返回字母序最靠后（以 W 开头）的书名。

- **学生:** （回应讲师询问为何查询出版社时出现了异常结果）是因为引号的问题吗？
- **Carter Zenke:** 是因为列名的拼写错误。讲师当时误将 `"publisher"` 拼写为 `"pubsliher"`（执行了 `SELECT "pubsliher" FROM "longlist";`），由于该列不存在而产生异常结果；改回正确的 `SELECT "publisher" FROM "longlist";` 后即正常显示出版社列表。