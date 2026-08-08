# simbest 定制化改造清单(变更记录)

> 本文件是 simbest layer **永久定制需求**(非 MVP)的变更记录:每一项定制是什么、为什么、
> 怎么实现、改了哪些文件。与 [`WORKFLOW.md`](./WORKFLOW.md)(流程规范)和
> [`MVP.md`](./MVP.md)(百度热搜 DEMO)互补。
>
> **定位**:这些都是"盖在官方 core 之上、随 layer 保留下来的私有化定制",不属于任何
> DEMO/验证项。core 永不改动;定制全部发生在 `deploy/layers/simbest/` 的 build 期 patch
> 与运行期 env。

## 改造原则

1. **不碰 core**:所有定制要么是 build 期 patch(改 `:source` 基镜像产物),要么是运行期
   env(经官方支持的配置点注入)。
2. **可恢复**:尽量用 CSS 隐藏 / env 覆盖,不删服务端逻辑,便于上游 UI 变化后重新对齐。
3. **有校验**:patch 用 `includes()` 锚点校验,core 结构一旦变化立即抛错,避免静默失效。

## 改造清单

### 1. 中文界面(build 期)

- **需求**:web-ui 默认全英文,需要中文界面。
- **实现**:
  - `web-ui/locales/zh-CN.json` — 英→中词条表(如 `Effort`→`思考深度`、
    `Harness`→`引擎`、`Thinking…`→`思考中…`)。
  - `web-ui/scripts/patch-zh.mjs` — build 期遍历 `dist-web` 替换英文、给 JS 加
    `.zh-<hash>` 缓存后缀并同步 `index.html`。
  - 执行时机:build `simbest-web-ui:source` 基镜像时(`web-ui/Dockerfile` patch 阶段)。
- **坑**:重建 source 镜像**必须 `--no-cache`**,否则 BuildKit 缓存命中跳过 patch 层,
  中文**静默失效**(页面全英文且 build 不报错)。0.2.0 重建踩过。
- **验证**:`curl -s http://localhost:8082 | grep -o 'index-[^"]*\.js'` 应含 `.zh-<hash>`。

### 2. 免签测试登录(build 期 + 运行期 env)

- **需求**:本地测试身份(`admin`/`zhangsan`)无需走签名登录。
- **实现**:
  - `images/web-ui-local/patch.mjs` / `images/admin-local/patch.mjs` — 注入
    `mintPortalIdentity`:当转发无 token 且 `ALLOW_UNSIGNED_TEST_IDENTITY=1` +
    `PORTAL_IDENTITY_SECRET` 时,按请求身份现场签发短期 token。
  - env:`ALLOW_UNSIGNED_TEST_IDENTITY=1`(web-ui/admin)、`WEB_UI_PRINCIPALS=admin,zhangsan`。
- **注意**:仅测试身份(`NODE_ENV=test`);生产环境不应开。

### 3. 品牌定制(2026-08-07)

官方支持 env 配置品牌,故**大部分走 env**,不改代码。

| 定制项 | 默认(官方) | simbest | env / patch | 机制 |
|---|---|---|---|---|
| favicon | 🏴‍☠️ 海盗旗 | `S` | `WEB_UI_FAVICON_EMOJI=S` | `serveEmojiFavicon` 把任意字符包进 SVG `<text>` |
| 自称/品牌名 | `QM` | `细码助理` | `ORG_BRAND_SELF_LABEL=细码助理` | `brandName()` 读 `meta[name=brand-self-label]`;`surface-config` `pick(db,env)` |
| 侧边栏字母 | `A` | `S` | `ORG_BRAND_MARK=S` | `shell.css` `--brand-mark`;`injectBranding` 注入 `:root{--brand-mark:"S"}` 覆盖默认 `"A"` |
| 浏览器标题后缀 | `· Web` | `· 工作台` | `patch.mjs` | `brandIndexHtml` 里 `${label} · Web` → `${label} · 工作台` |

- **注入链**:core env(`ORG_BRAND_*`)→ `brandingDefault` → `/v1/surface-config`
  `pick(db,env)`(库优先)→ `injectBranding` 写入 `index.html`(`<meta brand-self-label>` +
  `:root{--brand-mark,--brand-accent}`)。
- **决策**:官方本就提供 `ORG_BRAND_MARK`/`ORG_BRAND_SELF_LABEL` 配置点,直接用 env;
  favicon 有 `WEB_UI_FAVICON_EMOJI`。标题后缀官方无 env,故用 `patch.mjs` 文本替换。

### 4. 隐藏对话框控件(2026-08-07,2026-08-08 调整)

- **需求**:对话框(composer)里的"模型""引擎"及齿轮设置不对用户展示(纯 GLM 单模型部署,
  picker 经网关伪装显示 GPT 系,对终端用户误导;用户无需切换)。
- **决策**:官方无配置隐藏这些控件,故走 **build 期 CSS 覆盖**(客户端 `display:none`),
  不删服务端逻辑,可恢复。
- **实现**:`images/web-ui-local/patch.mjs` 在 `brandIndexHtml` 的 `injectBranding` 之后,
  往 `</head>` 前注入:

  ```css
  .menu-control.model-control,      /* 模型 picker(显示 GPT 系,经 glm-responses 网关伪装到 GLM) */
  .menu-control.harness-control,    /* 引擎 picker(单 pi) */
  .menu-control.settings-control,   /* 齿轮(含模型/引擎/思考深度/快速模式另一入口) */
  .fast-toggle                      /* Zap 快速模式(fastMode 仅 Opus,GLM 永久禁用,显示"快速"误导) */
  { display: none !important; }
  ```

- **🧠 effort 菜单保留显示**(2026-08-08 调整):glm-responses 网关新增 `mapThinkingFromEffort`
  (High/XHigh/Max → GLM `thinking:enabled`,其余 → `disabled`),🧠 Brain 菜单成为用户控制
  GLM 思考的入口(Auto=快 / High=深思),故从隐藏列表**移除** `.menu-control:has([aria-controls="composer-effort-menu"])`,
  并**新增** `.fast-toggle`(Zap 对 GLM 无效且误导)。原 2026-08-07 把 effort 一起藏了(那时
  网关不透传 thinking,🧠 无效)。
- **选择器来源**:`composer.ts` 的 `menuControl` 按 `kind` 设 `controlClass`
  (`model`→`model-control`、`harness`→`harness-control`);Zap 是 `<button class="fast-toggle">`;
  effort 菜单无 controlClass(靠 `aria-controls="composer-effort-menu"`),现保留显示。
- **风险**:上游若重命名 `controlClass`/`fast-toggle` class,隐藏失效(控件重新出现,非崩溃);
  `hideBefore` 锚点校验会在 `injectBranding` 调用点变化时抛错。需要时重新对齐选择器。

### 5. 隐藏侧边栏技术入口:应用 / 钥匙串(2026-08-07)

- **需求**:不向终端用户暴露左侧导航的两个偏技术入口:
  - **应用(Apps)** — `deploys` 视图,对应 core 的"部署应用"功能。该功能在 docker
    target(core 容器化)下因 DIND 路径/网络双重错配不可用(返回 bad_gateway),隐藏以避免误触。
  - **钥匙串(Keychain)** — `keychain` 视图,凭据/OAuth 保险库。本地测试场景不向终端用户暴露,
    与"应用"一致隐藏(功能本身走 core 标准数据通路,可用,非缺陷)。
- **决策**:与第 4 项一致,走 build 期 CSS 覆盖(`display:none`),不删服务端逻辑、不封路由,
  可恢复。
- **实现**:`images/web-ui-local/patch.mjs` 在第 4 项同一段注入的 `<style>` 里追加两条:
  ```css
  a.navrow[data-view="deploys"]{display:none !important}
  a.navrow[data-view="keychain"]{display:none !important}
  ```
- **选择器来源**:`shell.ts` 的 `navRow(v, glyph, label)` 渲染为
  `<a class="navrow" data-view=${v} ...>`;两项分别是
  `navRow("deploys", ICON.deploys, "Apps")` 与 `navRow("keychain", ICON.keychain, "Keychain")`,
  故 `data-view="deploys"` / `data-view="keychain"` 是稳定 key(不依赖中文化后的文案)。
- **范围**:仅隐藏侧边栏入口;通过 URL 直达 `#deploys` / `#keychain` 仍可访问(路由未封禁)。
  其中 `#deploys` 直达会 bad_gateway;`#keychain` 直达功能正常。需要更彻底的封禁再议。
- **风险**:上游若重命名 `navRow` 的 `data-view` 或改这两个视图 key,隐藏失效(入口重新
  出现,非崩溃);`hideBefore` 锚点会在 `injectBranding` 调用点变化时抛错。

## 同步上游时的注意

- 这些定制全在 layer,core 不动,故 `/update-qm` 后 `rebase main` 预期零冲突。
- **唯一需要人工复核的是 UI 结构依赖项**:第 3 项(patch.mjs 标题替换的 `${label} · Web`)
  和第 4 项(CSS 选择器)依赖上游 web-ui 的 HTML/类名结构。rebase 后若 web-ui 大改:
  - `patch.mjs` 的 `includes()` 锚点会抛 `"web-ui title shape changed"` /
    `"web-ui branding-inject shape changed"`,提示重新对齐。
  - 重新 build:见 `WORKFLOW.md` "本地镜像重建与中文化"(`--no-cache`!)。
