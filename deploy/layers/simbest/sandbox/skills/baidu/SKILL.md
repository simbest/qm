---
name: baidu
description: Read Baidu's realtime hot-search ranking (百度热搜) and summarize what is trending. Use when a user explicitly asks to see, read, list, or summarize 百度热搜, 热点榜, 热搜榜单, today's hot topics, or what is trending on Baidu. Do not use for general writing, non-Baidu sources, or requests that do not need a fresh trending list.
---

# 百度热搜

百度热搜只有一个榜单模式：读取当前实时热搜榜（`realtime`），或热词榜（`phrase`）。

```bash
baidu-hotlist --limit 20
baidu-hotlist --tab phrase --limit 10
```

默认 `--tab realtime`（实时热搜）、`--limit 20`（范围 1–50）。当用户没有明确说要热词榜时，用 `realtime`。

读返回的 JSON（`items` 数组，每条含 `rank`/`word`/`url`/`tag`）。注意：榜单只给**热搜词 + 百度搜索链接 + 标签**（热/新/辟谣等），**没有正文或摘要**。据此产出：

1. 一段简洁的中文热门话题概述，可按主题（时政/社会/财经/娱乐/科技等）归类。
2. 每条热搜给出它的百度搜索链接。
3. 标注标签（如"热""新""辟谣"），让用户区分"上榜"与"已核实"。

**不要**凭热搜词编造事件细节、原因或数字——热搜词只代表搜索热度，不代表事件全貌。区分"上榜"与"已证实"。若榜单为空或抓取失败，直接说明，不要编造热搜。
