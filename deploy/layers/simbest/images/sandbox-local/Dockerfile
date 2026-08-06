FROM simbest-sandbox:mvp-0.1.5

COPY aws/microvm-agent/agent.mjs /opt/microvm-agent/agent.mjs
COPY deploy/layers/simbest/sandbox/tools/baidu-hotlist/baidu-hotlist /usr/local/bin/baidu-hotlist

RUN chmod -R a+rx /usr/local/bin

LABEL org.simbest.local="mvp-0.1.9"

ENV HOME=/root
WORKDIR /root
EXPOSE 8080
CMD ["node", "/opt/microvm-agent/agent.mjs"]
