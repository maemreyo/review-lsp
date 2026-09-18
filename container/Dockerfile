FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

COPY review-lsp.tgz /tmp/review-lsp.tgz
RUN npm install -g --ignore-scripts --no-audit --no-fund --loglevel=error /tmp/review-lsp.tgz \
    && npm cache clean --force \
    && rm -f /tmp/review-lsp.tgz \
    && mkdir -p /candidate /input \
    && chmod 0555 /candidate /input

USER 65532:65532
ENTRYPOINT ["review-lsp"]
