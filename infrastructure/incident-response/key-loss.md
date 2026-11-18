# Incident runbook: TLS, DKIM, auth-encryption or backup key loss

## TLS certificate/private key
- Issue a new CA certificate for the same approved hostname, validate chain/hostname/expiry/key pair, then deploy with `infrastructure/tls/install-certificate.sh`.
- If service reload fails, the installer attempts to restore its previous pair. Verify external SMTP STARTTLS, IMAPS and HTTPS from outside the host.

## DKIM signing key
- Preserve the selector/public DNS TXT record. Restore the encrypted DKIM key-volume archive to an isolated volume, verify file ownership and private permissions, and verify the published DNS record matches the restored public key before making it active.
- If the private key cannot be recovered, create a new selector, publish the new public key, wait for DNS propagation, then switch signing configuration. Keep the old selector published during mail propagation.

## AUTH_ENCRYPTION_KEY
- Do not replace it with a new random value. Existing encrypted TOTP secrets will become unreadable.
- Restore the original key from the encrypted host-state backup or use the controlled re-encryption script with a verified backup and maintenance window.

## Restic repository key
- The Restic repository password and provider recovery credentials are intentionally excluded from host-state snapshots. Retrieve them from the independent offline escrow/secret manager. If unavailable, restore is not possible; rotate credentials only after confirming a separate repository access path.
