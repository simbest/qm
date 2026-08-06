FROM ghcr.io/yc-software/qm/core@sha256:bee03e7f22719dfe76ea2c83bb65db2bdefd55b714eae4014007033800bdb5ab

USER root
RUN apk add --no-cache docker-cli
RUN sed -i 's/maxTokens: entry.clone.maxTokens,/maxTokens: entry.clone.maxTokens, baseUrl: process.env.OPENAI_BASE_URL ?? template.baseUrl,/' /app/src/model/pi-models.ts
RUN sed -i 's#http://127.0.0.1:${port}${path}#http://${process.env.LOCAL_SANDBOX_HOST ?? "127.0.0.1"}:${port}${path}#' /app/src/sandbox/local-sandbox.ts
USER node
