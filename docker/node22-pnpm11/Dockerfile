FROM node:22-bookworm-slim

# Project commands run as an unprivileged user with a read-only container root.
# Keep toolchain home state on the writable, ephemeral /tmp tmpfs instead of /home/node.
ENV HOME=/tmp/agent-home

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && npm install --global pnpm@11.19.0 \
  && pnpm --version \
  && rm -rf /var/lib/apt/lists/*
