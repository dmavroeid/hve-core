# Copyright (c) 2026 Microsoft Corporation. All rights reserved.
# SPDX-License-Identifier: MIT
ARG TASK_BASE_IMAGE
FROM ${TASK_BASE_IMAGE}
USER 0:0
RUN test ! -e /node_modules \
    && ln -s /opt/vally-runtime/node_modules /node_modules
USER 1000:1000
