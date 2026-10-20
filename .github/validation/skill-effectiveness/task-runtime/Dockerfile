# Copyright (c) 2026 Microsoft Corporation. All rights reserved.
# SPDX-License-Identifier: MIT
FROM node:24.14.0-bookworm-slim@sha256:4bd6219054c8bebcd26a66bfd8ca0bd6e1024b4b97474c59bb7ee3bbcbef4fe8

ENV DO_NOT_TRACK=1 VALLY_TELEMETRY_OPTOUT=1 \
    UV_PYTHON_INSTALL_DIR=/opt/python PUPPETEER_CACHE_DIR=/opt/browser

ADD --checksum=sha256:20d79708222611fa540b5c9ed84f352bcd3937740e51aacc0f8b15b271c57594 \
    https://github.com/astral-sh/uv/releases/download/0.10.9/uv-x86_64-unknown-linux-gnu.tar.gz /tmp/uv.tar.gz

# Debian packages are recorded during the build, not resolved from a frozen snapshot.
RUN apt-get -o Acquire::Retries=0 update \
    && apt-get -o Acquire::Retries=0 install -y --no-install-recommends \
        git ca-certificates python3 python3-venv unzip \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
        libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 \
        libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 \
        fonts-liberation xdg-utils \
    && dpkg-query -W \
    && tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 \
        uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx \
    && rm /tmp/uv.tar.gz

WORKDIR /opt/vally-runtime
COPY --chown=0:0 .evidence-preflight/ ./
COPY --chown=0:0 .github/validation/skill-effectiveness/task-runtime/catalog-runtime/ /opt/catalog-runtime/
COPY --chown=0:0 .github/validation/skill-effectiveness/task-runtime/browser-sandbox.test.mjs validation/browser-sandbox.test.mjs
COPY --chown=0:0 .github/validation/skill-effectiveness/task-runtime/browser-sandbox-status.mjs validation/browser-sandbox-status.mjs
RUN npm ci --ignore-scripts --include=dev --no-audit --no-fund \
    && node -e 'const fs=require("node:fs"); for(const [name,version] of [["@microsoft/vally","0.19.0"],["@microsoft/vally-cli","0.19.0"],["@github/copilot-sdk","1.0.15"],["@github/copilot","1.0.89"]]) { if(JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`)).version!==version) throw Error(name); }' \
    && ln -s /opt/vally-runtime/node_modules/.bin/vally-docker-runner /usr/local/bin/vally-docker-runner \
    && uv python install 3.12.3 \
    && uv sync --frozen --project /opt/catalog-runtime --python 3.12.3 \
    && uv sync --frozen --project validation/python-runtime --python 3.12.3 \
    && validation/python-runtime/.venv/bin/python -m ipykernel install \
        --prefix /opt/vally-runtime/validation/python-runtime/.venv \
        --name hve-simplified-pilot --display-name "Trusted notebook control"

WORKDIR /opt/vally-runtime/validation/mermaid-runtime
RUN npm ci --ignore-scripts --include=dev --no-audit --no-fund \
    && npm exec --no -- puppeteer browsers install chrome \
    && node --input-type=module -e 'import fs from "node:fs"; import assert from "node:assert/strict"; import puppeteer from "puppeteer"; const executablePath=await puppeteer.executablePath(); assert.equal(typeof executablePath,"string"); assert.ok(fs.statSync(executablePath).isFile()); fs.writeFileSync("browser-config.json",JSON.stringify({executablePath,headless:true,args:["--disable-dev-shm-usage"]})+"\n"); console.log(JSON.stringify({browser:executablePath}));' \
    && test "$(id -u node)" = 1000 \
    && test "$(id -g node)" = 1000 \
    && chmod -R go-w /opt/vally-runtime /opt/catalog-runtime /opt/python /opt/browser

ENV PATH="/opt/vally-runtime/validation/python-runtime/.venv/bin:${PATH}" \
    JUPYTER_PATH=/opt/vally-runtime/validation/python-runtime/.venv/share/jupyter \
    QUEUE_DELAY_NOTEBOOK_PYTHON=/opt/vally-runtime/validation/python-runtime/.venv/bin/python \
    CATALOG_PYTHON=/opt/catalog-runtime/.venv/bin/python \
    MERMAID_CLI=/opt/vally-runtime/validation/mermaid-runtime/node_modules/@mermaid-js/mermaid-cli/src/cli.js \
    MERMAID_BROWSER_CONFIG=/opt/vally-runtime/validation/mermaid-runtime/browser-config.json \
    C4_CONTROL_EVIDENCE_DIR=/tmp/c4-control-images \
    HOME=/tmp/home XDG_CACHE_HOME=/tmp/cache \
    MPLCONFIGDIR=/tmp/matplotlib
WORKDIR /opt/vally-runtime
USER 1000:1000
CMD ["vally-docker-runner"]
