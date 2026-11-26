# CS50 SQL 第 0 讲课程笔记：查询、筛选、排序与聚合

## 一、查询基础：数据库概念与 SELECT 入门

### 为什么需要数据库与 SQL

在信息时代，日常使用搜索引擎、智能手机、智能手表和视频平台时都会产生大量数据。为了存储和管理这些数据，人们引入了数据库和 SQL，而其中最核心的“表”（table）概念其实已有数千年历史——讲师 Carter Zenke 展示了一张数千年前记录神庙工人津贴的图表，其中每一行代表一个具体条目（例如一位工人），每一列代表该条目的一项属性（例如某个月的津贴）。将这种结构应用到现代图书馆场景中，每行可以是一本书，两列分别是书名（title）和作者（author），例如 Toni Morrison 所著的 *Song of Solomon* 和 Margaret Wise Brown 所著的 *Goodnight Moon*。

虽然 Apple Numbers、Google Sheets、Microsoft Excel 等电子表格软件也能存放表格数据，但在以下三个方面，数据库比电子表格更有优势：

1. 规模（Scale）：当 Google、Instagram 等平台需要存储数百万乃至数十亿用户的数据时，数据库更适合处理如此庞大的数据量。
2. 更新频率：像 Twitter 这类每秒需要处理多次推文写入的场景，数据库能够更好地承受高频更新的负载。
3. 查找速度：在电子表格中查找内容类似使用 Command-F 或 Control-F 逐行搜索，而数据库可以使用更多种类的算法，从而更快速地检索数据。

数据库（database）是组织数据的一种方式，支持对数据进行创建（create）、读取（read）、更新（update）和删除（delete）操作。用户通常通过数据库管理系统（DBMS）与数据库交互，就像通过 VS Code 编写程序或通过桌面图标与操作系统交互一样。常见的 DBMS 包括 MySQL、Oracle、PostgreSQL、SQLite，以及课堂上学生提到的 Microsoft Access 和 MongoDB 等。在选择 DBMS 时需要权衡以下因素：

1. 授权与支持：商业闭源软件需要付费，但提供额外的实现支持；开源免费软件（如 PostgreSQL、MySQL、SQLite）则由使用者自行负责部署与实现。
2. 轻量与功能：MySQL、PostgreSQL 功能更全面但较重、需要更多计算资源；SQLite 更为轻量，但仍能完成大部分相同的操作。

本课程初期使用 SQLite，后续会逐步过渡到 MySQL 和 PostgreSQL。与这些数据库交互的语言是 SQL，即结构化查询语言（Structured Query Language）。它具有结构化的关键字，不仅能用于提问（如在 Instagram 分析获赞最多的帖子、在初创企业统计每日用户增减、在 Spotify 寻找相似歌曲），也能完成数据的创建、读取、更新和删除。SQLite 在现实中同样应用广泛，常用于内存较小的手机应用、桌面软件以及网站表单数据存储。

本讲使用的演示数据集是国际布克奖（International Booker Prize）入围长名单的图书数据库。关于该数据集的范围，Carter Zenke 在开场介绍时提到数据库包含 5 年的长名单（该奖项每年选出 13 本小说进入长名单），随后在回答学生提问时说明数据涵盖 2018 年至 2023 年（后续查询显示总计 78 条记录）。操作工具为集成开发环境 Visual Studio Code（简称 VS Code）中的终端与 SQLite。

### 启动 SQLite 与基本 SELECT 查询

在终端中输入 `ls` 可查看当前文件夹中的数据库文件 `longlist.db`。使用命令 `sqlite3 longlist.db`（`sqlite3` 表示 SQLite 软件的第三版）即可打开该数据库，此时终端提示符会变为 `sqlite`，表示已进入 SQLite 环境；使用 `Control-L` 可以清屏。

`SELECT` 是本讲介绍的第一个 SQL 关键字，用于从表（本例中表名为 `longlist`）中查询并获取行数据：

1. 查询所有列和所有行：`SELECT * FROM "longlist";`（其中 `*` 表示所有列，分号 `;` 表示一条查询语句结束）。由于终端窗口较小，这条语句会一次性返回大量数据。
2. 查询单列：`SELECT "title" FROM "longlist";`，结果仅按顺序列出所有书名。
3. 查询多列：列与列之间用英文逗号分隔，例如 `SELECT "title", "author" FROM "longlist";`，结果会同时返回 `title` 和 `author` 两列。
4. 限制返回行数：`LIMIT` 关键字用于限制查询结果返回的行数，适合在数据量很大时先预览前几条记录。执行 `SELECT "title" FROM "longlist" LIMIT 10;` 会返回数据集中的前 10 行；执行 `SELECT "title" FROM "longlist" LIMIT 5;` 则按数据加入表中的先后顺序返回前 5 个书名。

### 课堂问答

**学生:** 写 SQL 语句时必须像演示中那样在表名和列名周围加引号吗？

**Carter Zenke:** 通常建议在表名和列名（称为 SQL 标识符）周围使用双引号。之后还会用到字符串（由字符组成的序列），字符串一般使用单引号，这样可以用双引号表示列名、单引号表示字符串，是良好的代码风格规范。

**学生:** 这份图书列表的数据是从哪里获取的？

**Carter Zenke:** 这些数据来自公开渠道。国际布克奖官网提供了历年入围长名单（本例中为 2018 年至 2023 年的图书），而表中后续还会看到的这些图书的评分（rating）和投票数（votes）数据则来自图书评论聚合网站 Goodreads。

**学生:** 在终端里使用 SQLite 3 时是否区分大小写？演示中关键字用了大写，用小写字母可以吗？

**Carter Zenke:** 演示中将 SQL 关键字写成大写，表名和列名写成小写，但这并非强制要求。如果执行全小写的 `select title from longlist;` 依然能够正常返回结果，只是风格不够好。当别人阅读较长的查询语句时，将 SQL 关键字大写可以更清楚地区分关键字与列名等标识符。

## 二、条件筛选：WHERE、逻辑组合与模式匹配

### 使用 WHERE 与比较运算符

当不需要查看整张表，而只想筛选符合特定条件的行时，可以使用 `WHERE` 关键字：

1. 相等筛选：例如查询 2023 年入围的书名与作者，可执行 `SELECT "title", "author" FROM "longlist" WHERE "year" = 2023;`。因为 `year` 的值是整数，所以 `2023` 不需要加引号。同理，将年份改为 `2022` 或 `2021`，即可分别查出对应年份的入围图书。
2. 不相等筛选：`!=` 和 `<>` 都表示“不等于”，其中 `!=` 更常用。如果不想看硬皮精装本（`hardcover`），可以执行 `SELECT "title", "format" FROM "longlist" WHERE "format" != 'hardcover';`，其中 `'hardcover'` 是字符串，使用单引号，结果只返回平装本（paperback）图书；把 `!=` 换成 `<>` 会得到完全相同的结果。
3. 使用 `NOT` 取反：也可以在条件前加 `NOT` 关键字来否定条件，例如使用 `WHERE NOT` 配合 `"format"` 等于 `'hardcover'`，返回的结果与上述不等于查询一致。

### 组合多个条件：AND、OR 与括号

使用 `AND` 和 `OR` 可以将多个条件组合成复合条件，还可以使用括号 `()` 指定先判断哪一部分条件：

1. 满足其一（`OR`）：查询 2022 年或 2023 年入围的图书，可编写多行查询（在终端输入时未打分号前按回车可换行），例如 `SELECT "title", "author" FROM "longlist" WHERE "year" = 2022 OR "year" = 2023;`，结果返回这两年入围的所有图书。
2. 括号分组与多条件叠加：若想在 2022 年或 2023 年入围的图书中再排除精装本，可以先从 `"longlist"` 表查询 `"title"` 和 `"format"`，再用括号把 `"year" = 2022 OR "year" = 2023` 括起来作为一组条件，同时限定 `"format"` 不是 `'hardcover'`，最终结果仅返回 2022 和 2023 年出版的平装本图书。

### 缺失值判断：NULL、IS NULL 与 IS NOT NULL

当表中某项数据不存在或缺失时，在 SQL 中用 `NULL` 表示。国际布克奖的许多图书是从其他语言翻译为英文的，但部分作品没有单独的译者。判断值是否为空，可以使用 `IS NULL` 或 `IS NOT NULL`：

1. 查找缺失值：`SELECT "title", "translator" FROM "longlist" WHERE "translator" IS NULL;` 会返回两本书，分别是 *The Perfect Nine* 和 *the indictment of The Enlightenment of The Greengate Tree*（按字幕原文），其 `translator` 列为空。
2. 查找非空值：`SELECT "title", "translator" FROM "longlist" WHERE "translator" IS NOT NULL;` 会返回所有存在译者信息的书名和译者。

### 模糊匹配：LIKE、% 与 _

如果只想根据部分字符模糊匹配文本，可以使用 `LIKE` 关键字，并结合两个通配符使用：

1. 百分号 `%`：匹配任意长度的字符序列（包括位于单词前后或中间）。例如执行 `SELECT "title" FROM "longlist" WHERE "title" LIKE '%love%';`，会返回 4 本书名中带有 `love` 的书（例如 *Love in the Big City* 和 *More Than I Love My Life*）。如果只找书名以 `The` 开头的书，可写成 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'The%';`（演示中讲师先误用了双引号，随后改回单引号）。不过 `'The%'` 可能会意外匹配以 `There` 或 `They` 开头的书名，因此在 `'The'` 后加一个空格写成 `'The %'` 是更好的设计。
2. 下划线 `_`：仅匹配任意单个字符。例如忘记书名 *Pyre* 究竟拼作 `Pire` 还是 `Pyre` 时，可以执行 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'P_re';`，结果会返回 *Pyre*。

### 数值范围筛选：比较符与 BETWEEN

当需要查询连续多个年份（如 2019 至 2022 年）时，接连写多个 `OR "year" = ...` 会显得冗长，此时可以使用范围比较运算符（`>`、`<`、`>=`、`<=`）或 `BETWEEN ... AND ...`：

1. 使用 `>=` 与 `<=`：`SELECT "title", "year" FROM "longlist" WHERE "year" >= 2019 AND "year" <= 2022;`，结果返回 2019 至 2022 年的图书，但语句更简洁。
2. 使用 `BETWEEN`：`SELECT "title", "year" FROM "longlist" WHERE "year" BETWEEN 2019 AND 2022;` 会得到相同结果，其中 `BETWEEN` 包含边界值 2019 和 2022。
3. 筛选评分、投票数与页数：结合数据集中的评分和页数信息，可执行 `SELECT "title", "rating" FROM "longlist" WHERE "rating" > 4.0;` 找出评分高于 4.0 的图书；执行 `SELECT "title", "rating", "votes" FROM "longlist" WHERE "rating" > 4.0 AND "votes" > 10000;` 可将结果进一步缩小到 4 本既有高评分又有至少一万次投票的图书；执行 `SELECT "title", "pages" FROM "longlist" WHERE "pages" < 300;` 则能查出初版页数少于 300 页的图书。

### 课堂问答

**学生:** 为什么 SQL 会有不同的子集？

**Carter Zenke:** 官方的 SQL 语言标准由标准机构（他回忆好像是 ANSI）定义。不同的数据库管理系统只实现了其中的一部分功能，例如 SQLite 使用的是适用于 SQLite 的 SQL 子集，而 PostgreSQL 和 MySQL 各自也有对应的子集。

**学生:** 可以在终端里同时筛选 2022 年和 2021 年吗？

**Carter Zenke:** 可以，使用 `OR` 关键字即可将不同年份的条件组合在一起。

**学生:** 在编写查询时，我们怎么知道数据库里有哪些列名（例如 `title` 和 `author`）？

**Carter Zenke:** 后续课程会介绍如何查看数据库的表结构（schema）以了解其中包含哪些列。在本讲中，讲师在演示前已提前知晓表内的列名。

**学生:** 可以在两个词之间使用两个 `%` 吗？

**Carter Zenke:** 可以。例如查询以 `The` 开头且书名中包含 `love` 的书，可写成在 `WHERE "title" LIKE` 后使用 `'The%love%'` 的模式。运行后本数据库中没有符合该条件的书，因此返回空结果，但如果存在符合条件的书就会被查出。

**学生:** 下划线 `_` 只能匹配单个字符，如果想匹配多个未知字符，可以连续使用多个下划线吗？

**Carter Zenke:** 完全可以。例如查询 *Tyll* 时若确定以 `T` 开头且后面有三个字符，可用 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'T___';`（3 个下划线），结果返回 *Tyll*；若改用 `WHERE "title" LIKE 'TY____'`（`TY` 后接 4 个下划线），数据库中没有匹配项，返回空结果。

**学生:** 针对范围筛选和字符串匹配有两个问题：第一，进行数值运算时数据库里的列必须存为整数吗？第二，匹配字符串时是否区分大小写？

**Carter Zenke:** 第一个问题取决于数据库设计时为列选择的数据类型（后续课程会讲解）。在 `longlist` 表中，`year` 和 `votes` 是整数（integer），而 `rating` 是实数或浮点数（real number / float）。第二个问题中，`LIKE` 不区分大小写，例如 `WHERE "title" LIKE 'pyre'` 仍能返回首字母大写的 *Pyre*；而 `=` 区分大小写，执行 `SELECT "title" FROM "longlist" WHERE "title" = 'pyre';` 则不会返回任何结果。

## 三、排序与聚合：ORDER BY 与统计函数

### 结果排序：ORDER BY、ASC 与 DESC

如果希望按评分、字母顺序或投票数对查询结果排序，可以使用 `ORDER BY` 关键字：

1. 默认升序（`ASC`）：执行 `SELECT "title", "rating" FROM "longlist" ORDER BY "rating" LIMIT 10;` 后，返回结果从 `3.05` 和 `3.42` 开始，说明 `ORDER BY` 默认是从小到大（升序，`ASC`）排列。
2. 降序排列（`DESC`）：若要找出评分最高的 10 本书，需在排序列后加上 `DESC`（降序，从大到小），即 `SELECT "title", "rating" FROM "longlist" ORDER BY "rating" DESC LIMIT 10;`。结果会从 *The Eighth Life*（4.52 分）排到 *The Books of Jacob*（4.06 分）。
3. 多列排序打破平局：在最高分前十的榜单中，*Still Born* 和 *When We Cease to Understand the World* 的评分都是 `4.14`。此时可以在 `ORDER BY` 后用逗号列出多个排序依据，把 `votes` 也加入 `SELECT` 列中，先按 `rating` 降序、再按 `votes` 降序排列并限制前 10 条。结果显示 *When We Cease to Understand the World* 因投票数更多而排在更靠前的位置。

### 聚合函数与结果美化：AVG、ROUND、AS 等

SQL 的聚合函数（aggregate functions）能够对多行数据进行汇总计算，并返回一个单一的数值结果：

1. 计算平均值（`AVG`）与四舍五入（`ROUND`）：执行 `SELECT AVG("rating") FROM "longlist";` 可求出所有书的平均评分，结果为 `3.7537179471795`。为了便于展示，可嵌套使用 `ROUND` 函数保留两位小数：`SELECT ROUND(AVG("rating"), 2) FROM "longlist";`，结果变为 `3.75`（`ROUND` 接收两个参数，第一个是待处理的数值，第二个是保留的小数位数）。
2. 重命名结果列（`AS`）：使用 `ROUND` 后，输出表格的列标题会变成 `ROUND(AVG("rating"), 2)`。使用 `AS` 关键字可为其指定别名，例如 `SELECT ROUND(AVG("rating"), 2) AS "average rating" FROM "longlist";`，输出的列标题便会显示为整洁的 `average rating`。
3. 最大值（`MAX`）与最小值（`MIN`）：执行 `SELECT MAX("rating") FROM "longlist";` 返回最高评分 `4.52`；执行 `SELECT MIN("rating") FROM "longlist";` 返回最低评分 `3.05`。
4. 求和（`SUM`）：此前查看 `title` 和 `votes` 时，例如 *Go, Went, Gone* 在演示画面中大约有 592 票。执行 `SELECT SUM("votes") FROM "longlist";` 可汇总总投票数，结果显示有超过 60 万人参与了这些入围图书的评分。
5. 计数（`COUNT`）与空值处理：执行 `SELECT COUNT(*) FROM "longlist";` 会统计表中的所有行，返回 `78` 本书；但执行 `SELECT COUNT("translator") FROM "longlist";` 却只返回 `76`。这是因为之前查出有 2 本书的 `translator` 为 `NULL`——当向 `COUNT` 传入具体列名时，它只统计非空（non-null）的值，而 `COUNT(*)` 会统计整张表的全部行数。

### 统计去重与退出环境：DISTINCT 与 .quit

如果要统计表中有多少家不同的出版社，直接执行 `SELECT COUNT("publisher") FROM "longlist";` 会重复计数（得到 78 家）。在演示查询出版社列表时，讲师一度不小心把 `"publisher"` 拼写成了 `"pubsliher"`，由于该列不存在而出现了异常输出；更正后执行 `SELECT "publisher" FROM "longlist";`，可以看到 *Harvill Secker* 和 *MacLehose Press* 等出版社出现了多次。

此时可以使用 `DISTINCT` 关键字去除重复值：

1. 查看去重后的出版社列表：`SELECT DISTINCT "publisher" FROM "longlist";`，每个出版社只会显示一次。
2. 统计不重复的出版社数量：`SELECT COUNT(DISTINCT "publisher") FROM "longlist";`，结果为 `33` 家不同的出版社。

当需要退出 SQLite 终端提示符返回系统命令行时，可以输入 `.quit`。需要注意的是，`.quit` 是 SQLite 特有的命令，而不是 SQL 关键字。课程最后预告，下一讲将学习如何把目前这张单表拆分为图书、出版社、作者等多张相互关联的表。

### 课堂问答

**学生:** 能否查询精确到小数点后特定位数（如 4.93）的评分？

**Carter Zenke:** 可以使用 `WHERE` 条件精确匹配。例如演示 `SELECT "title", "rating" FROM "longlist" WHERE "rating" = 4.932;`（讲师在读出空结果时口头表述为没有 `4.392` 这个评分的书），如果存在该评分的图书就会被返回。

**学生:** `ORDER BY` 和 `DESC` 可以直接按字母顺序对字符串排序吗，还是需要特殊条件？

**Carter Zenke:** 可以直接用于文本。执行 `SELECT "title" FROM "longlist" ORDER BY "title";` 会按字母顺序（从 A 到 Z）排列书名；加上 `DESC` 执行 `SELECT "title" FROM "longlist" ORDER BY "title" DESC;` 则会按字母逆序排列。

**学生:** `AVG`、`COUNT`、`SUM` 这类命令有专门的统称吗？

**Carter Zenke:** 有的，它们被称为聚合函数（aggregate functions），因为它们能把多行数据（例如所有图书的评分）汇总合并成一个单一的单元格结果。

**学生:** `MAX` 和 `MIN` 函数能否用来查找最长或最短的字符串？

**Carter Zenke:** 执行 `SELECT MAX("title"), MIN("title") FROM "longlist";` 后，返回的结果分别是 *Wretchedness*（`MAX`）和 *A New Name-- Septology VI-VII*（`MIN`）。可以看到 `MAX` 返回的书名其实比 `MIN` 更短，说明它们并不是按字符串长度计算，而是按字母顺序排序：`MIN` 返回字母表最靠前（`A` 开头）的书名，而 `MAX` 返回字母表最靠后（`W` 开头）的书名。