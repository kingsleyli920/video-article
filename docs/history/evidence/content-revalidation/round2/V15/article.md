# CS50 SQL 第 0 讲课程笔记：查询、筛选、排序与聚合

## 一、查询：数据库基础与 SELECT 语句

### 表格、数据库与 DBMS 基础
在信息时代，人们与计算机及互联网的交互会产生海量数据，例如 Google 记录点击和搜索的网站、智能手机与智能手表记录健康信息和通讯内容，以及 YouTube 记录平台上的视频、创作者和评论。为了存储、管理和向这些数据提问，课程引入了数据库与 SQL。

1. 表格（Table）：讲师 Carter Zenke 以几千年前按行和列记录神庙工人津贴的图表为例，说明表格用于存储一组信息，每一行（row）代表集合中的一个条目，每一列（column）代表该条目的某项属性。若应用于现代图书馆场景，书名（title）与作者（author）可各自作为一列，每一本书作为一行。
2. 从电子表格转向数据库的原因：虽然 Apple Numbers、Google Sheets 和 Microsoft Excel 等软件可以存储表格，但在以下三方面数据库更具优势。一是规模（scale），如 Google 或 Instagram 需要存储数百万乃至数十亿用户数据；二是更新频率，如 Twitter 需要支持每秒多次发推的并发写入；三是检索速度，相比在电子表格中通过 Command-F 或 Control-F 逐行查找，数据库支持使用更多算法更快地搜索数据。
3. 数据库与数据库管理系统（DBMS）：数据库是一种以可创建、更新、读取和删除数据的方式组织数据的结构；DBMS 是通过图形界面或文本语言与数据库交互的软件。课程列举了 MySQL、Oracle、PostgreSQL 和 SQLite（学生也提到了 Microsoft Access 和 MongoDB）。选择 DBMS 时需要权衡：专有软件通常收费但提供实施支持，而 PostgreSQL、MySQL、SQLite 等开源免费软件需由使用者自行负责实施；此外，MySQL 和 PostgreSQL 功能更全面但较重、计算开销更大，而 SQLite 更轻量，常用于内存较低的手机应用、桌面应用或网站表单，同时也能完成大部分相同工作。本课程先使用 SQLite，后续逐步过渡到 MySQL 和 PostgreSQL。

### SQL 与课程案例环境准备
SQL 是 Structured Query Language（结构化查询语言）的缩写，用于通过关键字向数据库提问，并执行创建、读取、更新和删除操作。

本讲在 Visual Studio Code（VS Code）的终端中使用 `sqlite3`（SQLite 的第三版程序）打开国际布克奖入围书单数据库 `longlist.db`。国际布克奖每年选出 13 本小说列入入围长名单（longlist），评分与投票数据来自书评网站 Goodreads。关于数据库覆盖的年份范围，字幕前后口径不一致，未作统一：讲师先称数据库包含五年的入围书单，后在问答中称收录了 2018 年至 2023 年的书籍（后文统计总行数为 78 行）。

在终端输入 `sqlite3 longlist.db` 并回车后，终端提示符不再是美元符号，前面会显示 `sqlite`，表示已进入 SQLite 环境；可使用 `Control-L` 清屏。

### 基础查询：SELECT 与 LIMIT
1. 查询全部或指定列：使用 `SELECT` 关键字从指定表中取回行，语句末尾用分号 `;` 结束。若需查看表中的所有行和列，可用星号 `*`，例如 `SELECT * FROM "longlist";`。若只查看特定列，可列出列名并用逗号分隔，例如 `SELECT "title" FROM "longlist";` 或 `SELECT "title", "author" FROM "longlist";`。
2. 限制返回行数：面对可能包含数百万行的数据表，可使用 `LIMIT` 仅抽取前几行预览数据。例如 `SELECT "title" FROM "longlist" LIMIT 10;` 返回前 10 行书名，`SELECT "title" FROM "longlist" LIMIT 5;` 则按数据加入表中的顺序返回前 5 行书名。

### 课堂问答
- **提问学生：** 编写查询时，是否必须像讲师那样在单词两边加上引号？
- **Carter Zenke：** 通常建议在表名和列名（即 SQL 标识符）外加上双引号。后续课程还会用到字符串（字符集合），届时字符串使用单引号。用双引号表示列名、单引号表示字符串，是一种良好的编码风格规范。

- **提问学生：** 这份书单数据库里的信息是从哪里获取的？
- **Carter Zenke：** 数据来自多个公开渠道的整合。入围书单来自布克奖官方网站（此处称包含 2018 年至 2023 年的书籍），而后续会用到的评分与投票数量数据则来自聚合用户书评的 Goodreads 网站。

- **Vinayak：** SQLite 3 的语法是否区分大小写？是否可以使用小写字母来写 SQL 关键字？
- **Carter Zenke：** 关键字使用小写（例如 `select "title" from "longlist";`）同样可以正常运行，但不符合良好风格。将 SQL 关键字大写、表名和列名小写，能帮助阅读长查询的人迅速区分哪些是关键字，哪些是列名或标识符。

## 二、筛选：WHERE 条件、模糊匹配与范围查询

### 条件筛选与否定表达
使用 `WHERE` 关键字可以只返回满足特定条件的行，而不是整张表。

1. 相等比较：例如查询 2023 年入围的书名与作者，可执行 `SELECT "title", "author" FROM "longlist" WHERE "year" = 2023;`。由于 `2023` 是整数而非字符串，因此不加引号。同理可将年份替换为 `2022` 或 `2021`。
2. 不相等与 `NOT`：若要筛选非精装版（`hardcover`）的书籍，可使用 `!=` 或 `<>`，例如 `SELECT "title", "format" FROM "longlist" WHERE "format" != 'hardcover';` 或 `WHERE "format" <> 'hardcover';`（返回结果为平装版 `paperback` 书籍），其中 `'hardcover'` 作为字符串使用单引号。也可以在条件前使用 `NOT` 关键字取反，写成 `WHERE NOT "format" = 'hardcover';`。

### 复合条件与缺失值判断
1. `AND`、`OR` 与括号：通过 `AND` 和 `OR` 可以连接多个条件，并通过圆括号 `()` 指定优先计算的部分。例如查询 2022 年或 2023 年的书籍：`SELECT "title", "author" FROM "longlist" WHERE "year" = 2022 OR "year" = 2023;`（在未输入分号时按回车可以换行继续书写）。若要进一步限定为非精装版，可执行 `SELECT "title", "format" FROM "longlist" WHERE ("year" = 2022 OR "year" = 2023) AND "format" != 'hardcover';`，结果仅返回 2022 年和 2023 年的平装书。
2. 缺失值 `NULL`：在表中，`NULL` 表示该值不存在或缺失。由于部分入围书籍原本就是英文创作或没有单独的译者，`translator` 列可能为空。使用 `IS NULL` 可找出缺失译者的行：`SELECT "title", "translator" FROM "longlist" WHERE "translator" IS NULL;`，查询返回了 2 本书（字幕提及《The Perfect Nine》与另一本识别为 `the indictment of The Enlightenment of The Greengate Tree` 的书名），其译者列均为空。反之，使用 `WHERE "translator" IS NOT NULL;` 可返回所有存在译者的书籍。

### 模糊匹配：LIKE 与通配符
当无法精确匹配整个字符串时，可使用 `LIKE` 配合两种通配符进行模式匹配。

1. 百分号 `%`：匹配任意数量（零个或多个）的任意字符。例如 `SELECT "title" FROM "longlist" WHERE "title" LIKE '%love%';` 可找出书名中任意位置包含 `love` 的 4 本书（字幕提及包括《Love in the Big City》和《More Than I Love My Life》）。若要查找以 `The` 开头的书名，可写 `WHERE "title" LIKE 'The%';`（演示时讲师指出最初误写了双引号，随后更正为单引号）。不过 `'The%'` 可能会意外匹配以 `There` 或 `They` 开头的单词，更严谨的写法是在 `The` 后加上空格：`'The %'`。
2. 下划线 `_`：精确匹配单个任意字符。当忘记《Pyre》一书中间是 `i` 还是 `y` 时，可执行 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'P_re';`，结果成功返回 `Pyre`。

### 范围条件查询
使用比较运算符 `>`、`<`、`>=`、`<=` 以及 `BETWEEN ... AND ...` 可以更简洁地表达数值区间，避免冗长的 `OR` 拼接。

1. 年份区间：`SELECT "title", "year" FROM "longlist" WHERE "year" >= 2019 AND "year" <= 2022;` 等价于使用包含边界值的 `BETWEEN` 写法：`SELECT "title", "year" FROM "longlist" WHERE "year" BETWEEN 2019 AND 2022;`。
2. 评分、票数与页数筛选：`SELECT "title", "rating" FROM "longlist" WHERE "rating" > 4.0;` 可查出评分高于 4.0 的书籍。若结合投票数筛选，执行 `SELECT "title", "rating", "votes" FROM "longlist" WHERE "rating" > 4.0 AND "votes" > 10000;`，结果缩小至 4 本书。此外，`SELECT "title", "pages" FROM "longlist" WHERE "pages" < 300;` 可找出初版页数少于 300 页的书籍。

### 课堂问答
- **提问学生：** SQL 是否存在不同的子集？
- **Carter Zenke：** 是的。SQL 由标准机构（讲师提到应为 ANSI）定义了官方语言标准，而不同数据库管理系统（如 SQLite、PostgreSQL、MySQL）会各自实现并支持其中的相应子集。

- **Tayas：** 能否在终端里把 2022 年和 2021 年同时加入查询条件？
- **Carter Zenke：** 可以，随后在课程中演示了使用 `OR` 等条件组合来实现跨年份筛选。

- **提问学生：** 使用者如何提前知道表里有哪些列名（例如 `title` 和 `author`）？
- **Carter Zenke：** 后续课程会介绍如何查看数据库的模式（schema）以了解包含的列；本节课先假定已经提前获知表中的列名。

- **提问学生：** 能否在两个词之间使用两个 `%` 号？
- **Carter Zenke：** 可以，例如 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'The%love%';` 表示以 `The` 开头且后面任意位置包含 `love` 的书名，只是当前数据库中没有符合该条件的书，因此返回空结果。

- **提问学生：** 能否连续使用多个下划线 `_` 来匹配多个字符？
- **Carter Zenke：** 完全可以。随后演示 `SELECT "title" FROM "longlist" WHERE "title" LIKE 'T___';`（`T` 后跟三个下划线）成功匹配到 `Tyll`；而尝试 `LIKE 'TY____'`（`TY` 后跟四个下划线）时则无匹配结果。

- **提问学生：** 进行范围或条件运算时，数据库中的数据必须存储为整数吗？另外，字符串匹配是否区分大小写？
- **Carter Zenke：** 第一，所需数据类型取决于建库时的设计（后续课程会讲解如何选择列类型），在本例中 `year` 和 `votes` 为整数，`rating` 为实数（浮点数）；第二，`LIKE` 不区分大小写，例如 `WHERE "title" LIKE 'pyre'` 仍能返回 `Pyre`，而 `=` 区分大小写，`WHERE "title" = 'pyre'` 不会返回任何结果。

## 三、排序：ORDER BY 的升序、降序与多列排序

### 升序（ASC）与降序（DESC）
使用 `ORDER BY` 可以按指定列对查询结果进行排序。`ORDER BY` 的默认排序方式为升序（`ASC`，从小到大）。因此，若直接执行 `SELECT "title", "rating" FROM "longlist" ORDER BY "rating" LIMIT 10;`，返回的是评分最低的 10 本书（从 3.05、3.42 等开始）。

若要找出评分最高的 10 本书，需在列名后显式加上降序关键字 `DESC`（从大到小）：`SELECT "title", "rating" FROM "longlist" ORDER BY "rating" DESC LIMIT 10;`。该查询返回的前 10 名中，最高分为《The Eighth Life》（4.52），第 10 项为《The Books of Jacob》（4.06）。

### 多列排序与文本排序
1. 多列排序打破平局：在按评分降序排列的结果中，《Still Born》与《When We Cease to Understand the World》的评分均为 4.14。为了在评分相同时按投票数高低排序，可在 `ORDER BY` 后用逗号列出多个排序规则：`SELECT "title", "rating", "votes" FROM "longlist" ORDER BY "rating" DESC, "votes" DESC LIMIT 10;`。执行后，投票数更多的《When We Cease to Understand the World》排在了前面。
2. 文本按字母排序：`ORDER BY` 同样适用于文本列。`SELECT "title" FROM "longlist" ORDER BY "title";` 默认按字母表正序排列，加上 `DESC` 后则按字母表逆序排列。

### 课堂问答
- **提问学生：** 能否筛选具体到如 4.93 至 4.9 的评分？（字幕原文：`can we write rating to 4.93 to 4.9?`）
- **Carter Zenke：** 若要查找某个特定评分，可以结合 `WHERE` 与 `=`（讲师以口述的某特定小数值演示 `WHERE "rating" = ...`，字幕先后口述为 `4.932` 与 `4.392`，口径不一致，未作统一）。由于表中没有该精确评分的书，查询返回空结果。

- **提问学生：** `DESC` 能直接用于字符串的字母排序，还是需要针对字母设置特殊条件？
- **Carter Zenke：** 可以直接用于文本列。`ORDER BY "title"` 默认按字母表正序排列，指定 `DESC` 后则会按字母表逆序排列。

## 四、聚合：聚合函数、去重与结果美化

### 常用聚合函数与结果格式化
聚合函数（aggregate functions）能够将多行数据合并计算，最终返回单个数值。

1. `AVG`（平均值）、`ROUND`（四舍五入）与 `AS`（重命名）：执行 `SELECT AVG("rating") FROM "longlist";` 可求得所有书的平均评分 `3.7537179471795`。为便于展示，可用 `ROUND` 将其保留两位小数：`SELECT ROUND(AVG("rating"), 2) FROM "longlist";`，返回 `3.75`。但此时输出的表头会直接显示函数表达式，因此可配合 `AS` 为结果列起一个可读性更好的别名：`SELECT ROUND(AVG("rating"), 2) AS "average rating" FROM "longlist";`。
2. `MAX`（最大值）与 `MIN`（最小值）：`SELECT MAX("rating") FROM "longlist";` 返回最高评分 `4.52`；`SELECT MIN("rating") FROM "longlist";` 返回最低评分 `3.05`。
3. `SUM`（求和）：在 Goodreads 数据演示中，讲师举例假设《Go, Went, Gone》一书可能获得了约 592 票。执行 `SELECT SUM("votes") FROM "longlist";` 可统计所有入围书目的总投票数，结果超过 60 万。
4. `COUNT`（计数）与 `NULL` 值：`SELECT COUNT(*) FROM "longlist";` 统计整张表的总行数，返回 `78`。然而，执行 `SELECT COUNT("translator") FROM "longlist";` 时只返回 `76`。这是因为 `COUNT(*)` 统计所有行，而 `COUNT("列名")` 只统计该列中非 `NULL` 的值，跳过了 2 条译者为空的记录。

### 使用 DISTINCT 去重
如果直接查询 `SELECT "publisher" FROM "longlist";`，会发现同一家出版社（如 Harvill Secker、MacLehose Press）在多本书中重复出现（演示中讲师曾误将列名拼写为 `"pubsliher"`，因该列不存在而输出了异常数据）。因此，直接统计 `publisher` 列不能代表不同出版社的实际数量。

使用 `DISTINCT` 关键字可以过滤重复值：`SELECT DISTINCT "publisher" FROM "longlist";` 会让每家出版社仅出现一次。将其嵌套进 `COUNT` 中：`SELECT COUNT(DISTINCT "publisher") FROM "longlist";`，可得出数据库中共有 `33` 家不同的出版社。

### 退出环境与课程小结
在 SQLite 交互环境中，可使用 `.quit` 退出提示符并返回终端（注意 `.quit` 是 SQLite 的命令，而非 SQL 关键字）。本讲围绕单张图书表介绍了查询、筛选、排序与聚合；下一讲将学习如何把信息拆分为多张表，以表达书籍、出版社和作者等不同实体之间的关系。

### 课堂问答
- **提问学生：** 这类命令是否也有一个名称？
- **Carter Zenke：** 它们统称为聚合函数（aggregate functions），因为其作用是将多行数据聚合、合并为一个单元格内的单一结果。

- **提问学生：** `MAX` 和 `MIN` 能否用于查找最长或最短的字符串？
- **Carter Zenke：** 演示执行 `SELECT MAX("title"), MIN("title") FROM "longlist";`，结果返回 `Wretchedness` 与 `A New Name: Septology VI-VII`（字幕原文为 `A New Name-- Septology VI-VII`）。讲师据此指出，结果可能并非依据字符串长度，而似乎是按字母表顺序比较：`MIN` 给出字母表最靠前的标题（以 `A` 开头），`MAX` 给出字母表靠后的标题（以 `W` 开头）。

- **提问学生：** （回应查询 `"pubsliher"` 时为何出现异常结果）是不是因为引号的问题？
- **Carter Zenke：** 是的，同时讲师表示自己好像拼错了查询，将 `publisher` 误输成了 `pubsliher`，而该列并不存在，于是 SQL 生成了这些数据。