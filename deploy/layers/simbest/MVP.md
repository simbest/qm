# MVP — 百度热搜 DEMO

> 本文件记录 simbest layer 的**第一个 MVP**:百度热搜抓取 DEMO 的需求与实现。
> 它是"私货 tool + skill 机制能否端到端跑通"的最小验证,不是正式产品功能。
> 与 [`WORKFLOW.md`](./WORKFLOW.md)(流程规范)、[`SIMBEST_CUSTOM.md`](./SIMBEST_CUSTOM.md)(定制变更记录)互补。

## 1. 背景与定位

simbest 需要验证一条完整链路:**自定义 sandbox tool → 由 skill 包装 → 被 harness(pi 经
glm-responses 网关接 GLM)调用 → 在 web-ui 中文界面展示**。为此选了一个**国内可达、无需
鉴权、纯 JSON、无需无头浏览器**的数据源作为 MVP:百度热搜。

- 2026-08-06 用百度热搜**替换了**此前的头条热搜 MVP。
- 选型理由:百度 `top.baidu.com/api/board` 是公开 JSON 接口,国内直连、无登录、无反爬门槛,
  适合做最小验证。
- 网关层面:删头条后 `glm-responses` 已还原为纯协议转换(见 `WORKFLOW.md` 私货清单),业务逻辑
  回到标准 skill 机制——百度热搜正是验证这一点的 DEMO。

## 2. DEMO 范围

**做什么**

- 抓取百度实时热搜榜(realtime)或热词榜(phrase)。
- 每条只给:排名 `rank`、热搜词 `word`、百度搜索链接 `url`、标签 `tag`(热/新/辟谣/沸/爆)。
- 由 skill 用中文按主题归类解读,并在正文后以 JSON 列出展示的条目。

**不做什么(数据边界)**

- 榜单**不提供**正文、摘要、来源、发布时间、热度数值。
- skill 不得凭热搜词编造事件细节/原因/数字——热搜词只代表搜索热度,不代表事件全貌。
- 区分"上榜"与"已证实"。

## 3. 架构

DEMO 由两部分组成,都在 `deploy/layers/simbest/sandbox/`:

```
sandbox/
├─ tools/baidu-hotlist/        # 工具:可执行抓取脚本 + 工具声明
│  ├─ baidu-hotlist            # node 脚本(无第三方依赖,纯 fetch)
│  └─ tool.json                # 工具定义(命令/提示/egress/安装)
└─ skills/baidu/
   ├─ SKILL.md                 # 何时触发、命令、输出格式
   └─ agents/openai.yaml       # OpenAI 兼容 agent 接口
```

- **tool** 是被 sandbox 执行的命令行程序(`install.binary: baidu-hotlist`)。
- **skill** 是给模型的"使用说明",决定何时调用、如何解读、如何输出。
- egress 仅 `top.baidu.com`(在 `tool.json` 声明,受 sandbox 出网策略约束)。

## 4. 工具:baidu-hotlist

### 数据源

`GET https://top.baidu.com/api/board?platform=wise&tab={realtime|phrase}`

- 公开 JSON,无需鉴权。
- 请求头 `user-agent` 固定为桌面 Chrome UA,`accept: application/json`。

### 参数

| 参数 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `--tab` | `realtime` | `realtime`/`phrase` | 实时热搜 / 热词榜 |
| `--limit` | `20` | 1–50 | 取榜单前 N 条 |
| `--timeout-ms` | `20000` | 5000–60000 | 单次抓取超时 |

### 解析逻辑

百度 board 结构是 `data.cards[].content[]`,但热词条目有时直接挂在 `content`、有时再包一层
`content[0].content[]`(实测 wise 平台是后者)。`findHotItems()` 两者兼容,按"含 `.word` 的
最深 content 数组"定位,避免百度改版时整条链路失效。

- 跳过 `isTop === true` 的置顶项(通常为推广/口号,无 `index`)。
- `rank` 取 `index`,`word`/`url`/`tag` 分别取字段;`tag` 优先 `labelTagName`(辟谣/沸/爆)
  否则 `newHotName`(热/新)。
- 按 `rank` 升序,截取 `--limit` 条。

### 输出

stdout 写一个 JSON:

```json
{
  "site": "百度热搜",
  "fetchedAt": "2026-08-06T11:09:00.756Z",
  "tab": "realtime",
  "status": "ok",
  "items": [
    { "rank": 1, "word": "...", "url": "https://m.baidu.com/s?word=...", "tag": "热" }
  ],
  "warnings": []
}
```

- 无条目时 `status: "error"`、`exitCode = 1`(但 stdout 仍写 JSON,便于排查)。

## 5. Skill:baidu

### 触发(`SKILL.md`)

当用户明确想看/列举/汇总"百度热搜 / 热点榜 / 热搜榜单 / 今天有什么热点 / 百度趋势"时触发;
不用于一般写作或非百度来源。

### 输出格式(关键约束)

每次响应两部分:

1. **正文**:中文按主题(时政/社会/财经/娱乐/科技)归类概述,每条给百度搜索链接并标标签。
2. **JSON**:` ```json ` 代码块,列出**本次正文实际展示**的条目(`word` 改名为 `title`),
   只含 `rank`/`title`/`url`/`tag`,省略一切不可得字段(无 `null`、不编造)。

> 复用历史榜单做筛选/重排/取子集时,只要正文列了条目,就必须追加 JSON;条目必须取自真实
> 返回,不得凭记忆编造。

### agent 接口(`agents/openai.yaml`)

`display_name: 百度热搜`,`default_prompt` 预置"用 $baidu 读取 → 中文解读 → 追加 JSON
(字段 rank/title/url/tag)"。

## 6. 验证

工具单元(从 `deploy/layers/simbest/`):

```bash
# 直接跑脚本(本机有 node 即可)
node sandbox/tools/baidu-hotlist/baidu-hotlist --limit 5
node sandbox/tools/baidu-hotlist/baidu-hotlist --tab phrase --limit 3
```

端到端(web-ui 已部署):

1. web-ui 用 zhangsan 身份发起一轮,消息含"看下百度热搜"。
2. harness 经 glm-responses 网关调 GLM → 触发 baidu skill → sandbox 执行 `baidu-hotlist`。
3. 回答应为中文热点概述 + JSON 代码块。

> 端到端验证的免浏览器方法见记忆 `simbest-skill-verification`:调 web-ui `/api/turn` +
> zhangsan cookie + 轮询 postgres。

## 7. 维护与风险

- **百度改版**:`findHotItems` 的双结构兼容是主要防线;若百度再改版导致 `data.cards` 结构
  变化,工具抛 `"board response has no hot-search items"`,需重新对齐解析。
- **egress**:仅 `top.baidu.com`;若 sandbox 出网策略收紧,确认该域名放行。
- **UA/反爬**:当前用固定桌面 Chrome UA,未带 cookie;若百度加反爬,可能需要补 cookie 或换接口。
- **数据时效**:榜单实时变动,`fetchedAt` 标记抓取时刻;不要缓存历史榜单冒充实时。

## 8. 验收标准(DEMO 成功标志)

- [ ] `baidu-hotlist --limit 5` 本机直连返回 ≥1 条 `status: ok` 的 JSON。
- [ ] web-ui 中文界面下,问"百度热搜"能触发 skill,得到中文概述 + JSON。
- [ ] JSON 条目只含 `rank`/`title`/`url`/`tag`,无编造字段。
- [ ] 榜单为空/抓取失败时,skill 如实说明,不编造热搜。
