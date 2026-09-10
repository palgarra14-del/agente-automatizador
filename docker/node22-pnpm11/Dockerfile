FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && npm install --global pnpm@11.19.0 \
  && pnpm --version \
  && rm -rf /var/lib/apt/lists/*
