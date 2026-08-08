# ⚠️ SOURCE 层 Dockerfile —— 只产 `simbest-web-ui:source`(core build + patch-zh 中文化)。
# 切勿 `docker build -f web-ui/Dockerfile -t simbest-web-ui-local:...`:会跳过
# images/web-ui-local/patch.mjs(免签登录 + 标题「工作台」+ 隐藏控件/sidebar CSS),
# 定制**静默失效**(server 照常起,只表现为英文标题、被藏控件冒出,不报错)。
# 正确流程:`npm run build:web-ui`(= source + local 两层)→ `npm run deploy`。
# 详见 WORKFLOW.md「本地镜像重建与中文化」。core/admin 同构(images/<svc>-local/)。
FROM node:24-alpine AS build
WORKDIR /app
ARG WEB_UI_BASE=/
ENV WEB_UI_BASE=$WEB_UI_BASE
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci
COPY plugins/web-ui/index.html plugins/web-ui/vite.config.ts plugins/web-ui/tsconfig.json ./
COPY plugins/web-ui/src ./src
COPY plugins/chassis/src /chassis/src
RUN npm run build

# ---- 中文化 patch 阶段 ----
COPY deploy/layers/simbest/web-ui/locales/zh-CN.json /tmp/zh-CN.json
COPY deploy/layers/simbest/web-ui/scripts/patch-zh.mjs /tmp/patch-zh.mjs
RUN node /tmp/patch-zh.mjs /app/dist-web /tmp/zh-CN.json

FROM node:24-alpine
WORKDIR /app
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci --omit=dev && rm package-lock.json \
  && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/web-ui/server ./server
COPY plugins/chassis/src /chassis/src
COPY --from=build /app/dist-web ./dist-web

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/index.ts"]
