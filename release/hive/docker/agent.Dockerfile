# syntax=docker/dockerfile:1.6
# OmegaDots agent image: SWI-Prolog + PeTTa + the Python packages an Omega needs.
# The OmegaClaw-Core checkout and the agent's memory are mounted at run time by
# the hive's docker driver, so code updates do not need an image rebuild.
#
#   docker build -f hive/docker/agent.Dockerfile -t omegadots/agent:dev hive/docker
#
# Behind a TLS-intercepting proxy, pass its CA as a build secret:
#   --secret id=extra_ca,src=/path/to/ca.crt --build-arg HTTPS_PROXY=... --network host
ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}

ARG SWIPL_TAG=V10.0.2
ARG PETTA_REPO=https://github.com/trueagi-io/PeTTa
ARG PETTA_REF=main
ENV LANG=C.UTF-8 \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    PIP_NO_CACHE_DIR=1

RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then \
      cp /run/secrets/extra_ca /usr/local/share/ca-certificates/extra-build-ca.crt && update-ca-certificates; \
    fi && \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build git pkg-config \
      libgmp-dev libssl-dev libedit-dev libyaml-dev libpcre2-dev zlib1g-dev libarchive-dev && \
    git clone -q --depth 1 --branch "${SWIPL_TAG}" https://github.com/SWI-Prolog/swipl.git /tmp/swipl && \
    cd /tmp/swipl && for m in clib swipy plunit json sgml http zlib libedit pcre yaml chr clpqr cpp utf8proc archive ssl; do \
      git submodule update --init --depth 1 -q "packages/$m"; done && \
    mkdir build && cd build && \
    cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DSWIPL_PACKAGES_X=OFF -DSWIPL_PACKAGES_JAVA=OFF \
      -DSWIPL_PACKAGES_ODBC=OFF -DSWIPL_PACKAGES_QT=OFF -DINSTALL_DOCUMENTATION=OFF -DBUILD_TESTING=OFF \
      -DCMAKE_INSTALL_PREFIX=/usr/local .. >/dev/null && ninja >/dev/null && ninja install >/dev/null && \
    cd / && rm -rf /tmp/swipl && \
    git clone -q "${PETTA_REPO}" /opt/PeTTa && git -C /opt/PeTTa checkout -q "${PETTA_REF}" && \
    pip install janus-swi chromadb openai websockets requests && \
    apt-get purge -y build-essential cmake ninja-build && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* && \
    useradd --create-home --uid 10001 dot && mkdir -p /agent && chown dot /agent

USER dot
WORKDIR /agent
CMD ["sh", "/opt/PeTTa/run.sh", "/agent/run.metta"]
