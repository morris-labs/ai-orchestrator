# The Agent Box image: one container per project runs the keeper, a tmux
# session per box, and the agentbox engine.
#
# Build it with scripts/build-image.sh, which packs the engine into
# image/dist/ and passes every pin in image/versions.env as a build argument.
# An installed .deb carries this directory under /usr/share/agentbox/image/,
# with the engine tarballs already in dist/, so the setup wizard can build
# the image without a source checkout.

# ubuntu:26.04, pinned by the digest of its multi-platform index.
# Looked up 2026-10-28 from registry-1.docker.io. To move to a newer base,
# run scripts/bump-versions.sh --base.
FROM ubuntu:26.04@sha256:0e73b71479e7bc5f006bca872e25c3cd680dc052a0116f90d63ae363537db0dd

# The container user takes the host user's name, so file ownership in the
# bind mounts matches the host. The uid and gid stay 1000 (see the remap
# step).
ARG USER_NAME=user

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install curl first so the GitHub CLI apt repo step can run.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI apt repo. curl writes the keyring with -o rather than through a
# pipe, so a failed download fails this step instead of leaving an empty
# keyring for `apt-get install gh` to trip over later.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list

# Passing --build-arg CACHEBUST_PACKAGES=$(date +%s) busts this layer and
# everything after it: apt packages, NodeSource, nvm, SDKMAN, the agent
# CLIs, and the engine. Use it for a full package update without pulling a
# new base image.
ARG CACHEBUST_PACKAGES=1
RUN echo "packages cache key: ${CACHEBUST_PACKAGES}" && \
    apt-get update && apt-get install -y --no-install-recommends \
    # core utilities; iproute2 provides the `ss` command the engine's port
    # discovery polls
    git wget zip unzip sudo tmux jq iproute2 \
    # GitHub CLI and git extras
    gh tig lazygit git-delta bat git-lfs git-filter-repo pre-commit \
    # C and C++ toolchain
    build-essential cmake ninja-build clang gdb valgrind pkg-config \
    # Java and Maven
    openjdk-21-jdk maven \
    # Python
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu 24.04 and later base images ship a uid and gid 1000 "ubuntu" user.
# Rename it to match the host user's name.
RUN usermod -l "${USER_NAME}" ubuntu && \
    groupmod -n "${USER_NAME}" ubuntu && \
    usermod -d "/home/${USER_NAME}" -m "${USER_NAME}"

# Passwordless sudo: the container is a disposable sandbox, so a sudo
# password adds no safety. Container root is still host root on the bind
# mounts; docs/architecture.md ("Container boundaries") lists what that
# allows. sudo ignores sudoers.d files whose names contain a dot, so the file
# has a fixed name rather than the user name.
RUN echo "${USER_NAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/claude-box && \
    chmod 0440 /etc/sudoers.d/claude-box

# System Node.js 22 from NodeSource: it runs the agent CLIs and the engine.
# Ubuntu's own nodejs package lags behind.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

USER ${USER_NAME}

# nvm and Node.js LTS for project work inside the container. The nvm
# installer is pinned (NVM_VERSION); the LTS release is whatever is current
# at build time. A "current" symlink gives PATH a fixed directory.
ARG NVM_VERSION
RUN test -n "${NVM_VERSION}" || { echo "NVM_VERSION is not set; build with scripts/build-image.sh" >&2; exit 1; } && \
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash && \
    bash -c '. "$HOME/.nvm/nvm.sh" && nvm install --lts && nvm alias default node && \
      ln -s "$NVM_DIR/versions/node/$(nvm version default)" "$NVM_DIR/current"'

# SDKMAN and Gradle, the default Gradle release at build time.
RUN curl -fsSL https://get.sdkman.io | bash && \
    bash -c 'source "$HOME/.sdkman/bin/sdkman-init.sh" && sdk install gradle'

# nvm and SDKMAN only add their PATH lines to ~/.bashrc, which a
# non-interactive `bash -c` never reads. Expose both toolchains through
# PATH, using the "current" symlinks, so gradle and the nvm node resolve in
# every shell.
ENV NVM_DIR=/home/${USER_NAME}/.nvm
ENV SDKMAN_DIR=/home/${USER_NAME}/.sdkman
ENV PATH=${NVM_DIR}/current/bin:${SDKMAN_DIR}/candidates/gradle/current/bin:${PATH}

# The agent CLIs, pinned in image/versions.env. They sit after the toolchain
# so a version bump, or --build-arg CACHEBUST=$(date +%s), rebuilds only
# this layer and the ones after it. /usr/bin/npm is the system npm, not the
# nvm one that PATH finds first. Each CLI's version goes in its own
# /etc/*-version file, which the server reads for the image status.
USER root
ARG CACHEBUST=1
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
ARG COPILOT_VERSION
RUN echo "agent CLI cache key: ${CACHEBUST}" && \
    for v in CLAUDE_CODE_VERSION CODEX_VERSION COPILOT_VERSION; do \
      test -n "${!v}" || { echo "$v is not set; build with scripts/build-image.sh" >&2; exit 1; }; \
    done && \
    /usr/bin/npm install -g --no-audit --no-fund \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@github/copilot@${COPILOT_VERSION}" && \
    root="$(/usr/bin/npm root -g)" && \
    for pair in /etc/claude-code-version:@anthropic-ai/claude-code:CLAUDE_CODE_VERSION \
                /etc/codex-version:@openai/codex:CODEX_VERSION \
                /etc/copilot-version:@github/copilot:COPILOT_VERSION; do \
      file="${pair%%:*}"; rest="${pair#*:}"; pkg="${rest%:*}"; pin="${rest##*:}"; \
      /usr/bin/node -p "require('${root}/${pkg}/package.json').version" > "$file" && \
      test "$(cat "$file")" = "${!pin}" || { echo "$file doesn't match ${pin}" >&2; exit 1; }; \
    done

# The engine, from the tarballs scripts/build-image.sh packs into dist/:
# @agentbox/engine and the workspace packages it depends on, such as
# @agentbox/contracts. npm installs them together into one prefix, so the
# engine's dependency on a private workspace package resolves to the
# sibling tarball instead of the npm registry. The engine layer comes last
# among the installs because it changes most often.
ARG AGENTBOX_ENGINE_VERSION
COPY dist/ /tmp/agentbox-dist/
RUN test -n "${AGENTBOX_ENGINE_VERSION}" || { echo "AGENTBOX_ENGINE_VERSION is not set; build with scripts/build-image.sh" >&2; exit 1; } && \
    test -f "/tmp/agentbox-dist/agentbox-engine-${AGENTBOX_ENGINE_VERSION}.tgz" || \
      { echo "dist/agentbox-engine-${AGENTBOX_ENGINE_VERSION}.tgz is missing; run scripts/build-image.sh" >&2; exit 1; } && \
    mkdir -p /usr/local/lib/agentbox/engine && \
    /usr/bin/npm install --prefix /usr/local/lib/agentbox/engine \
      --omit=dev --no-audit --no-fund --no-package-lock /tmp/agentbox-dist/*.tgz && \
    engine_pkg=/usr/local/lib/agentbox/engine/node_modules/@agentbox/engine && \
    /usr/bin/node -p "require('${engine_pkg}/package.json').version" > /etc/agentbox-engine-version && \
    test "$(cat /etc/agentbox-engine-version)" = "${AGENTBOX_ENGINE_VERSION}" && \
    engine_bin="$(/usr/bin/node -p "const p=require('${engine_pkg}/package.json'); typeof p.bin === 'string' ? p.bin : p.bin['agentbox-engine']")" && \
    printf '#!/bin/sh\n# Runs the engine on the system Node.js 22, whatever nvm puts first on PATH.\nexec /usr/bin/node %s "$@"\n' \
      "${engine_pkg}/${engine_bin#./}" > /usr/local/bin/agentbox-engine && \
    chmod 0755 /usr/local/bin/agentbox-engine && \
    rm -rf /tmp/agentbox-dist

# The keeper scripts the server runs: keeper.sh is the container's PID 1
# and starts the engine; start-session.sh starts one box's tmux session.
COPY --chmod=0755 keeper/keeper.sh keeper/start-session.sh /usr/local/lib/agentbox/

USER ${USER_NAME}

# The server sets the working directory (-w) and the command (the keeper)
# for every container it creates, so the image has no CMD. This directory
# is only a fallback.
WORKDIR /home/${USER_NAME}/workspace

# The engine's health route needs no token. AGENTBOX_ENGINE_PORT comes from
# the server; 20411 is the engine's default port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${AGENTBOX_ENGINE_PORT:-20411}/api/v1/health" > /dev/null || exit 1
