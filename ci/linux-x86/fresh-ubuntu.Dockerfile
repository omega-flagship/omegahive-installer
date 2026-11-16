# Purpose: boot a fresh Ubuntu as its standard install has it (systemd with logind, sudo, Python 3) and nothing the installer must add itself.
ARG RELEASE
FROM ubuntu:${RELEASE}
ENV container=docker
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv libpam-systemd dbus sudo python3 \
    && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
