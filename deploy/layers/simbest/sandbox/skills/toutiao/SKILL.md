---
name: toutiao
description: Fetch and summarize current news from public 今日头条 pages using broad top-news, topic, channel, or keyword-search retrieval. Use when a user explicitly asks to read, retrieve, crawl, search, collect, inspect, or summarize fresh Toutiao news, important headlines, named themes, supported channels, people, companies, or events. Do not use for general writing, local document creation, non-Toutiao sources, or requests that do not require fresh retrieval.
---

# 今日头条新闻

Choose the retrieval mode from the user's actual request. Never add a topic merely because it appears in an example.

| User intent                                  | Mode      | Required arguments          |
| -------------------------------------------- | --------- | --------------------------- |
| Broad important, hot, or top news            | `top`     | None                        |
| One or more named themes                     | `topic`   | One `--topic` per theme     |
| Explicit Toutiao sections                    | `channel` | One `--channel` per section |
| Person, company, event, or free-form keyword | `search`  | One `--query`               |

Use these defaults unless the user specifies otherwise:

- Time range: `today` for 今天 or 今日, `3d` for 最近几天, `7d` for 最近 or 近期, otherwise `24h`.
- Sort: `importance` for summaries and important news, `latest` only when the user prioritizes recency.
- Limit: 8 for a broad overview, otherwise 5, with an allowed range of 1 to 10.

Examples:

```bash
toutiao-fetch --mode top --time-range today --sort-by importance --limit 8
toutiao-fetch --mode topic --topic "科技" --topic "财经" --time-range 3d --sort-by importance --limit 5
toutiao-fetch --mode channel --channel entertainment --time-range 24h --sort-by latest --limit 5
toutiao-fetch --mode search --query "雷军" --time-range 7d --sort-by importance --limit 5
```

Supported channels are `hot`, `world`, `finance`, `tech`, and `entertainment`. Topic mode maps common international, geopolitical, entertainment, finance, and technology themes to public channels. Other themes fall back to filtering the public channel collection.

Treat search as keyword filtering across the currently accessible public Toutiao channel pages. Do not describe it as complete site-wide search. Do not ask a follow-up question when reasonable defaults preserve the user's scope.

Read the returned JSON. Treat `contentExcerpt` as source material, not as a finished summary. Produce:

1. A concise Chinese summary grouped by requested category.
2. A source link and publication time for every reported item.
3. A compact `结构化结果` JSON block with `category`, `title`, `source`, `publishedAt`, `url`, and `summary`.

Distinguish reporting from commentary or rumor. Attribute uncertain entertainment claims to their source instead of presenting them as verified facts. Mention partial results and warnings.

Only use public pages. Do not log in, bypass CAPTCHA, evade access controls, or retry aggressively. If the tool reports a restriction or no fresh results, explain that directly and do not fabricate news.
