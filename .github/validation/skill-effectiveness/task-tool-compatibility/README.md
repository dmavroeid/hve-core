---
title: Task-tool compatibility controls
description: Portable locked prerequisites for trusted local catalog, notebook, and C4 controls.
ms.date: 2026-10-21
---

## Scope

These projects supply trusted test prerequisites, not an evaluation runner.
The Vally/SDK package, original task inputs, skills, and assessment criteria
are unchanged. Model-free checks do not establish skill effectiveness.

Use the existing approved registry override when your environment requires one.
Keep committed registry URLs public; do not generate locks through a private
mirror, bypass package approval, or disable TLS verification.

## Renderer setup

From the renderer directory, use Node 24 or later:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
$env:PUPPETEER_CACHE_DIR = Join-Path $PWD '.browser-cache'
npm run browser:install
npm run browser:configure
```

Point `MERMAID_CLI` at the installed Mermaid CLI and
`MERMAID_BROWSER_CONFIG` at the generated `browser-config.json`.
The setup selects Puppeteer's matching Chrome Headless Shell. Full Chrome
produced local navigation timeouts during Windows qualification. The tested
setup changes neither checker timeouts nor browser sandbox settings.
The absolute executable path is generated locally and must not be committed.

## Python setup

The catalog and notebook projects contain public-source `uv.lock` files.
Use Python 3.12 and restore into their own `.venv` directories. On a network
that routes packages through an approved index, `uv export --frozen` followed
by `uv pip sync --require-hashes` can preserve the locked versions and hashes
while using the operator's configured index. Do not write that index into
committed manifests or locks.

Register the notebook kernel only within its owned environment. Trusted
control kernels and browsers require explicit execution approval. No paid
candidate or judge calls are part of this setup.
