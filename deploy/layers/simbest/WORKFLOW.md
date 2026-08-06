# simbest 开发工作流

本文件是 simbest 私有 fork 的**日常工作规范**,给人和 AI agent 用。

通用的私有 fork 规则(判断身份、不编辑 core、layer 隔离、`--repo`、不引用上游
PR 号等)由根 `AGENTS.md` 的 "Private forks" 章节给出,上游维护、随 `update-qm`
自动更新——**这里只写 simbest 特定的部分,不重复通用规则**。

## 身份

- 本仓库是 `yc-software/qm` 的**私有 fork**(plain clone,非 GitHub Fork 按钮)。
- 两个 remote:`origin` = simbest/qm(私有,可读写);`upstream` = yc-software/qm(官方,只读)。
- 核心纪律:**core(`deploy/layers/simbest/` 之外的一切)保持与上游字节一致**;所有
  simbest 特定内容只在 `deploy/layers/simbest/`。

## 私货清单(只在 `deploy/layers/simbest/`)

- `plugins/glm-responses/` — **pi 的 GLM 网关**(核心,勿删):responses↔chat 协议转换 + 工具协议强化(让 GLM 走 native function calling)+ model 伪装(`gpt-5.6-sol`→`glm-5.2`)。当前 pi 经它接 GLM(`OPENAI_BASE_URL=http://glm-responses:8080/v1`)。2026-08-06 删头条改百度热搜后,网关已还原为纯协议转换,业务逻辑回到标准 skill 机制。
- `sandbox/tools/baidu-hotlist/` + `sandbox/skills/baidu/` — 百度热搜抓取工具与 skill(MVP 示例:国内可达、无需鉴权)
- `web-ui/locales/zh-CN.json` + `web-ui/scripts/patch-zh.mjs` — 中文界面
- `qm.config.jsonc`、`images/*/Dockerfile`、`test/`、`slack-app-manifest.yml` 等部署物料

## 模型接入决策(2026-08-06)

- **harness 用 pi**(`qm.config.jsonc`: `HARNESS=pi`),**已弃用 codex**。
- pi 通过 `glm-responses` 网关接 GLM,**不是** pi-ai 直连,也**未启用**官方 `custom provider`。
- 官方 `custom provider` 虽支持 pi + GLM,但**不能替代 `glm-responses`**——网关做 responses↔chat 协议转换 + 工具协议强化(让 GLM 走 native function calling)+ model 伪装,改直连会丢失这些。故保留网关。
- 已删除 `sandbox/tools/codex-glm-provider/`(codex 专属,弃用 codex 后无用;官方 `custom provider` 本就管不到 codex,删它安全)。

## 分支策略

| 分支 | 内容 | 用途 |
|---|---|---|
| `main` | 纯 core(= upstream + 同步合并) | 与上游 ff 同步,**不放私货** |
| `tl-cooker`(开发分支) | core + simbest layer 私货 | 日常开发在这里 |

> 私货 commit 只进开发分支,不进 `main`。这样 `main` 永远是 upstream 的快照,
> 每次 `/update-qm` 都是干净 fast-forward、零冲突。

## 日常开发循环

1. 切到开发分支:`git switch tl-cooker`
2. **只在 layer 里改**:改动限制在 `deploy/layers/simbest/`
3. 验证(从仓库根):`node cli/bin/qm.ts check --config deploy/layers/simbest/qm.config.jsonc`
4. 提交:`git add deploy/layers/simbest/ && git commit -m '...'`
   (`.gitignore` 自动排除 `.env`、`node_modules`、`.generated`)
5. 推送:`git push origin tl-cooker`

## 本地镜像重建与中文化

simbest 的三个服务镜像(core/web-ui/admin)都是 `FROM <service>:source` 基镜像
再叠加 layer 定制 patch:

| 镜像 | 基镜像 | 定制内容 |
|---|---|---|
| `simbest-core-local` | `simbest-core:source` | sed 注入 baseUrl / local-sandbox host + 装 docker-cli |
| `simbest-web-ui-local` | `simbest-web-ui:source` | `patch.mjs` 改 server(免签测试登录) |
| `simbest-admin-local` | `simbest-admin:source` | `patch.mjs` |

**中文化**(`web-ui/locales/zh-CN.json` + `web-ui/scripts/patch-zh.mjs`)在 build
`simbest-web-ui:source` 基镜像时执行(`web-ui/Dockerfile` 的 patch 阶段):遍历
`dist-web` 把英文替换成中文,再给所有 JS 加 `.zh-<hash>` 缓存后缀并同步 `index.html`。

> ⚠️ **重建 source 镜像必须 `--no-cache`**。否则 BuildKit 会缓存命中、跳过
> `RUN node /tmp/patch-zh.mjs` 那一层,产物变纯英文——中文功能**静默失效**(页面照常
> 打开,只是全英文),且 build 不报错。2026-08-06 的 0.2.0 重建踩过这个坑。

### 正确的重建流程(在 `deploy/layers/simbest/` 下)

```bash
npm run build:web-ui-source   # --no-cache,保证 patch-zh 必执行
npm run build:web-ui-local    # 继承中文化 source,打 :0.2.0
npm run deploy                # qm up,用新镜像重建容器
```

> 各 local 镜像的 build script 都在 `package.json`,tag 已对齐 `qm.config.jsonc`
> 的 `imageOverrides`。**改 config 里的 tag 后,记得同步 `package.json` 的
> `build:*-local` tag**,否则会 build 出与 config 不符的旧 tag。

### 验证中文化

```bash
curl -s http://localhost:8082 | grep -o 'index-[^"]*\.js'   # 应含 .zh-<hash> 后缀
```
页面标题 `QM · Web`(英文) → `QM · 工作台`(中文)。

## 定期同步上游

用 `/update-qm` skill:`upstream/main` → 新建 sync 分支 → 合并 → PR → 合并进 `main`。
因为 core 无私改,预期永远是 fast-forward、零冲突。合并进 `main` 后,把开发分支的私货重放到新 `main` 上——开发分支是个人历史,用 **rebase**(不是 merge):私货都在 `deploy/layers/simbest/`,core 不碰它,所以零冲突:

```bash
git switch tl-cooker && git rebase main
```

## 安全红线(AI agent 必读)

1. **不编辑 core**。`deploy/layers/simbest/` 之外的文件(`src/`、`plugins/`(非 simbest)、
   `AGENTS.md`、`README.md`、CLI、CI……)一律不改。要改 core → 用 `upstream-pr` skill 发回上游。
2. **`deploy/layers/` 永不上行**。任何 layer 内容绝不 push 到 `upstream`。
3. **`.env` 永不入 git**。密钥只在 `.env`(已 gitignore);配置里只留 `.env.example`(密钥名,无值)。
4. **`gh` 命令必带 `--repo simbest/qm`**,防止误操作上游仓库的 PR。
5. **不引用上游 PR/issue 号**(如 `yc-software/qm#123`),会被 GitHub 镜像到上游时间线,泄露 fork 存在。用文字描述上游工作。

## AI 行为决策树

收到「改 / 加 X」请求时,先判断 X 属于哪类:

```
X 在 deploy/layers/simbest/ 里?
├─ 是 → 私货。在 layer 改 → qm check → commit → push origin 开发分支
└─ 否 → core。
        ├─ 是 simbest 特有需求? → 别改 core;和用户确认能否用 layer 方式实现
        └─ 是任何部署都需要的通用修复? → 用 /upstream-pr 发回上游
                                          (从 upstream/main 切干净分支 + scrub 防泄漏)
```

- 收到「同步 / 更新上游」→ `/update-qm`
- 收到「推送」→ 只推 `origin`,**绝不推 `upstream`**
