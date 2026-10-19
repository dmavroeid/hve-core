# Copyright (c) 2026 Microsoft Corporation. All rights reserved.
# SPDX-License-Identifier: MIT

FROM node:24.14.0-bookworm-slim@sha256:4bd6219054c8bebcd26a66bfd8ca0bd6e1024b4b97474c59bb7ee3bbcbef4fe8

ENV DO_NOT_TRACK=1 VALLY_TELEMETRY_OPTOUT=1

# OS packages use the base's public Debian repositories, not a frozen snapshot.
RUN apt-get -o Acquire::Retries=0 update \
    && apt-get -o Acquire::Retries=0 install -y --no-install-recommends git ca-certificates \
    && dpkg-query -W git ca-certificates coreutils libc-bin \
    && grep -RhE '^(URIs:|Suites:|Components:|deb )' /etc/apt/sources.list.d \
    && node --version \
    && npm --version

WORKDIR /opt/vally-runtime
COPY --chown=0:0 package.json package-lock.json ./
COPY --chown=0:0 restricted-copilot-executor.mjs ./scripts/restricted-copilot-executor.mjs
COPY --chown=0:0 combined-sdk-session.mjs ./

RUN npm ci --ignore-scripts --include=dev --registry=https://registry.npmjs.org/ \
        --fetch-retries=0 --fetch-timeout=60000 --no-audit --no-fund \
    && node -e 'const fs=require("node:fs"); for(const [name,version] of [["@microsoft/vally","0.19.0"],["@microsoft/vally-cli","0.19.0"],["@github/copilot-sdk","1.0.15"],["@github/copilot","1.0.89"]]) { const p=JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`)); if(p.version!==version) throw Error(`${name}: ${p.version}`); }' \
    && ln -s /opt/vally-runtime/node_modules/.bin/vally-docker-runner /usr/local/bin/vally-docker-runner \
    && test "$(id -u node)" = 1000 \
    && test "$(id -g node)" = 1000 \
    && chmod -R go-w /opt/vally-runtime

USER 1000:1000
CMD ["vally-docker-runner"]
