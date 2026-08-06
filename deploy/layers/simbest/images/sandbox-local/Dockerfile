FROM simbest-sandbox:mvp-0.1.5

COPY aws/microvm-agent/agent.mjs /opt/microvm-agent/agent.mjs
COPY deploy/layers/simbest/sandbox/tools/codex-glm-provider/codex-glm-provider /usr/local/bin/codex-glm-provider
COPY deploy/layers/simbest/sandbox/tools/toutiao-fetch/toutiao-fetch /usr/local/bin/toutiao-fetch

RUN chmod -R a+rx /usr/local/bin

LABEL org.simbest.local="mvp-0.1.8"

ENV HOME=/root
WORKDIR /root
EXPOSE 8080
CMD ["node", "/opt/microvm-agent/agent.mjs"]
