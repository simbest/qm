FROM simbest-web-ui-local:0.1.4

USER root
COPY images/web-ui-local/patch.mjs /tmp/patch.mjs
RUN node /tmp/patch.mjs && rm /tmp/patch.mjs
USER node
