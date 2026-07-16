FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# apt mirrors (esp. ports.ubuntu.com for arm64) are frequently partially down;
# apt's default retry/timeout budget gives up before cycling through to a
# working address, so widen it before the first apt-get call.
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/99retries \
    && echo 'Acquire::http::Timeout "30";' >> /etc/apt/apt.conf.d/99retries \
    && echo 'Acquire::https::Timeout "30";' >> /etc/apt/apt.conf.d/99retries

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl wget git jq rsync ca-certificates unzip build-essential \
    python3 python3-venv python3-pip less vim sudo openssh-client gnupg \
    && rm -rf /var/lib/apt/lists/*

# uv + uvx, installed system-wide so any user can run them
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# Node (for npx skills add ...)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with passwordless sudo, since install.sh may need it
# (global npm/pip installs, writing to /usr/local/bin, etc.)
RUN useradd -m -s /bin/bash -G sudo dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev \
    && chmod 0440 /etc/sudoers.d/dev

WORKDIR /home/dev/repo
COPY --chown=dev:dev . .

USER dev
ENV HOME=/home/dev \
    PATH="/home/dev/.local/bin:${PATH}"

CMD ["/bin/bash"]
