# Fail2ban compatibility entry points

The maintained host integration lives under
`infrastructure/security/` and is the authoritative implementation. Use its
log preparation, validated CIDR allowlist, jail template, alert action and
logrotate configuration:

```sh
sudo bash infrastructure/security/prepare-security-logs.sh
docker compose up -d --force-recreate postfix dovecot admin-ui
FAIL2BAN_IGNOREIP='127.0.0.1/8 ::1/128 <TRUSTED_VPN_CIDR>' \
  bash infrastructure/security/install-fail2ban.sh --check
sudo env INSTALL_FAIL2BAN=YES \
  FAIL2BAN_IGNOREIP='127.0.0.1/8 ::1/128 <TRUSTED_VPN_CIDR>' \
  bash infrastructure/security/install-fail2ban.sh --install
```

`install.sh`, `status.sh` and `unban.sh` in this directory are retained only
as compatibility wrappers. Do not copy the legacy `jail.d/mailcore.local`
file or `infrastructure/logrotate/mailcore-auth`; those are superseded by
`infrastructure/security/fail2ban/jail.d/mailcore.local.template` and
`infrastructure/security/logrotate/mailcore`.

Fail2ban runs on the host. Do not mount the Docker socket or expose container
runtime privileges to the ban service. Validate all filters and trusted CIDRs
from a second management session before enabling firewall bans.
