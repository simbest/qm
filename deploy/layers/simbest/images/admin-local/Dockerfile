FROM ghcr.io/yc-software/qm/admin@sha256:ec071338547e17d44337441d3144a068e6f3119fc377b2d9dd5c75d5b210c604

USER root
COPY images/admin-local/patch.mjs /tmp/patch.mjs
RUN node /tmp/patch.mjs && rm /tmp/patch.mjs
USER node
