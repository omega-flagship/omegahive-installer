# Purpose: boot a fresh Ubuntu as its standard install has it (systemd with logind, sudo, Python 3) and nothing the installer must add itself.
ARG RELEASE
FROM ubuntu:${RELEASE}
ENV container=docker
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv libpam-systemd dbus sudo python3 \
    && rm -rf /var/lib/apt/lists/*
# The kernel is the host's. A privileged container's /proc/sys, binfmt_misc and module loading reach it, so a fresh
# machine's boot settings would only overwrite the host's: on 17 Nov this image's systemd-sysctl applied
# 10-coredump-debian.conf and set its host's kernel.core_pattern to core. The units that write kernel-wide state stay off.
RUN systemctl mask systemd-sysctl.service systemd-binfmt.service systemd-modules-load.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
