const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isFresh,
  matchesQuery,
  normalizeChannel,
  parseArgs,
  parseArticlePage,
  parseChannelPage,
  publishedAtFromRelative,
  queryTokens,
  sortItems,
  timeRangeToMaxAgeHours,
  topicToSelection,
} = require("../sandbox/tools/toutiao-fetch/toutiao-fetch");

test("maps supported topics to the intended public channels", () => {
  assert.equal(topicToSelection("地缘政治").id, "world");
  assert.equal(topicToSelection("娱乐八卦").id, "entertainment");
  assert.equal(topicToSelection("财经市场").id, "finance");
  assert.equal(topicToSelection("人工智能与芯片").id, "tech");
  assert.equal(topicToSelection("本地房产"), null);
});

test("parses all retrieval modes and normalizes channel aliases", () => {
  assert.deepEqual(parseArgs(["--mode", "top", "--time-range", "today", "--limit", "8", "--max-age-hours", "12"]), {
    mode: "top",
    topics: [],
    channels: [],
    query: null,
    limit: 8,
    timeRange: "today",
    sortBy: "importance",
    maxAgeHours: 12,
    timeoutMs: 35000,
  });
  assert.deepEqual(parseArgs(["--mode", "topic", "--topic", "科技", "--topic", "财经"]).topics, ["科技", "财经"]);
  assert.deepEqual(parseArgs(["--mode", "channel", "--channel", "财经"]).channels, ["finance"]);
  assert.equal(parseArgs(["--mode", "search", "--query", " 雷军 "]).query, "雷军");
  assert.equal(normalizeChannel("娱乐"), "entertainment");
  assert.throws(() => parseArgs(["--mode", "search"]), /requires --query/);
});

test("parses article cards without treating image and comment links as articles", () => {
  const page = `
[国际新闻标题](https://www.toutiao.com/article/7670229608075199014/)
* [![Image](https://img.example/a.jpg)](https://www.toutiao.com/article/7670229608075199014/)
[新华社国际](https://www.toutiao.com/c/user/token/source/?source=feed)
[5 评论](https://www.toutiao.com/article/7670229608075199014/#comment)
3小时前
[娱乐新闻标题](https://www.toutiao.com/article/7670181376225788431/)
[文娱观察](https://www.toutiao.com/c/user/token/ent/?source=feed)
8小时前
`;
  const items = parseChannelPage(page, "地缘政治", "https://www.toutiao.com/ch/news_world/");
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => [item.title, item.source, item.relativePublished]),
    [
      ["国际新闻标题", "新华社国际", "3小时前"],
      ["娱乐新闻标题", "文娱观察", "8小时前"],
    ],
  );
});

test("parses article metadata and source paragraphs", () => {
  const page = `Title: 伊朗：谈判取得积极进展
URL Source: https://www.toutiao.com/article/7670229608075199014/
Published Time: 2026-08-05T01:28:49+08:00

Markdown Content:
# 伊朗：谈判取得积极进展

2026-08-05 01:28·[新华社国际](https://www.toutiao.com/c/user/token/source/)

第一段新闻正文，包含足够的信息用于生成摘要。

第二段新闻正文，补充事件背景和后续安排。

![Image](https://img.example/a.jpg)

举报
`;
  const item = parseArticlePage(page, {
    category: "地缘政治",
    title: "fallback",
    source: null,
    publishedAt: null,
    url: "https://www.toutiao.com/article/7670229608075199014/",
    contentExcerpt: null,
  });
  assert.equal(item.title, "伊朗：谈判取得积极进展");
  assert.equal(item.source, "新华社国际");
  assert.equal(item.publishedAt, "2026-08-04T17:28:49.000Z");
  assert.match(item.contentExcerpt, /第一段新闻正文/);
  assert.match(item.contentExcerpt, /第二段新闻正文/);
});

test("keeps channel metadata when an article page is only a generic shell", () => {
  const item = parseArticlePage(
    `Title: 今日头条
URL Source: https://www.toutiao.com/article/1/

Markdown Content:
[](https://www.toutiao.com/)
登录
`,
    {
      category: "地缘政治",
      title: "频道页真实标题",
      source: "频道作者",
      publishedAt: "2026-08-05T01:00:00.000Z",
      url: "https://www.toutiao.com/article/1/",
      contentExcerpt: null,
    },
  );
  assert.equal(item.title, "频道页真实标题");
  assert.equal(item.source, "频道作者");
  assert.equal(item.publishedAt, "2026-08-05T01:00:00.000Z");
});

test("normalizes relative publication times and enforces freshness", () => {
  const now = new Date("2026-08-05T04:00:00.000Z");
  assert.equal(publishedAtFromRelative("3小时前", now), "2026-08-05T01:00:00.000Z");
  assert.equal(isFresh("2026-08-02T05:00:00.000Z", 72, now), true);
  assert.equal(isFresh("2026-08-02T03:59:59.000Z", 72, now), false);
  assert.equal(timeRangeToMaxAgeHours("today", new Date("2026-08-05T04:00:00.000Z")), 12.25);
});

test("filters public-channel results by normalized query tokens", () => {
  const tokens = queryTokens("近期关于 雷军 的新闻");
  assert.deepEqual(tokens, ["雷军"]);
  assert.equal(matchesQuery({ title: "雷军宣布小米新计划", source: "科技日报", contentExcerpt: "" }, ["雷军"]), true);
  assert.equal(matchesQuery({ title: "其他公司发布新品", source: "科技日报", contentExcerpt: "" }, ["雷军"]), false);
});

test("sorts by importance or publication time deterministically", () => {
  const items = [
    {
      title: "国际频道旧闻",
      channelPriority: 75,
      channelRank: 0,
      channelMentions: ["world", "hot"],
      publishedAt: "2026-08-04T00:00:00.000Z",
    },
    {
      title: "热点频道新文",
      channelPriority: 100,
      channelRank: 0,
      channelMentions: ["hot"],
      publishedAt: "2026-08-05T03:00:00.000Z",
    },
  ];
  assert.equal(sortItems([...items], "importance")[0].title, "热点频道新文");
  assert.equal(sortItems([...items], "latest")[0].title, "热点频道新文");
});
