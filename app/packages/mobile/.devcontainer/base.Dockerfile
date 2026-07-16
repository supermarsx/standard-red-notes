FROM node:26.5.0-bookworm

ARG USERNAME=node
ARG NPM_GLOBAL=/usr/local/share/npm-global

ENV LANG=C.UTF-8
ENV PATH=${NPM_GLOBAL}/bin:${PATH}

RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        iproute2 \
        jq \
        less \
        locales \
        nano \
        openssh-client \
        procps \
        sudo \
        unzip \
        wget \
        zsh \
    && echo "${USERNAME} ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME} \
    && rm -rf /var/lib/apt/lists/*

# Keep global developer tools writable by the non-root devcontainer user.
RUN if ! getent group npm >/dev/null 2>&1; then groupadd --system npm; fi \
    && usermod --append --groups npm ${USERNAME} \
    && install --directory --owner=${USERNAME} --group=npm --mode=2775 ${NPM_GLOBAL} \
    && touch /usr/local/etc/npmrc \
    && chown ${USERNAME}:npm /usr/local/etc/npmrc \
    && echo "export PATH=${NPM_GLOBAL}/bin:\$PATH" > /etc/profile.d/npm-global.sh \
    && npm config --global set prefix ${NPM_GLOBAL} \
    && su ${USERNAME} -c "npm config --global set prefix ${NPM_GLOBAL}" \
    && su ${USERNAME} -c "npm install --global corepack@0.35.0 eslint@9.39.5" \
    && corepack enable

USER ${USERNAME}
