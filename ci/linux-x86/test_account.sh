#!/bin/sh
# Purpose: create the fresh test account, allowed by sudo to run exactly the installer's fixed system setup commands.
# Usage, as root: test_account.sh <user> <release id>
set -eu
user=$1
release=$2
useradd --create-home --shell /bin/bash "$user"
profile="/etc/apparmor.d/omegahive-mind-launcher-$(id -u "$user")"
source="/home/$user/.local/share/omegahive/releases/$release/launcher.apparmor"
rules=/etc/sudoers.d/90-hive-ci
printf '%s ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/loginctl enable-linger %s, /usr/bin/install -o root -g root -m 0644 %s %s, /usr/sbin/apparmor_parser -r %s\n' \
    "$user" "$user" "$source" "$profile" "$profile" > "$rules"
printf 'Defaults!/usr/bin/apt-get env_keep += "DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l"\n' >> "$rules"
chmod 0440 "$rules"
visudo -cf "$rules"
