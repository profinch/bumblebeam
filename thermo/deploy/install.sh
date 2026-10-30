#!/bin/sh
# Install or update thermo on this host: sudo ./deploy/install.sh (from the thermo directory)
set -eu
cd "$(dirname "$0")/.."
id thermo >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin thermo
install -d -m 0755 /opt/thermo /opt/thermo/web
install -m 0644 thermo.py /opt/thermo/
install -m 0644 web/* /opt/thermo/web/
install -m 0644 deploy/thermo-collect.service deploy/thermo-web.service /etc/systemd/system/
[ -e /etc/thermo.conf ] || install -m 0640 -g thermo thermo.conf.example /etc/thermo.conf
systemctl daemon-reload
systemctl enable thermo-collect thermo-web
systemctl restart thermo-collect
sleep 3
systemctl restart thermo-web
systemctl --no-pager --lines=5 status thermo-collect thermo-web
