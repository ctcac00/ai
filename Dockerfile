FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/root

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl git jq rsync ca-certificates unzip build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node (for npx skills add ...)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY . .

ENV PATH="/root/.local/bin:${PATH}"

CMD ["bash"]
