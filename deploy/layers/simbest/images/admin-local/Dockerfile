FROM simbest-admin:source

USER root
COPY images/admin-local/patch.mjs /tmp/patch.mjs
RUN node /tmp/patch.mjs && rm /tmp/patch.mjs
USER node
