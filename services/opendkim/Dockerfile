FROM ubuntu:24.04

LABEL org.opencontainers.image.title="MailCore OpenDKIM" org.opencontainers.image.base.name="ubuntu:24.04"

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    opendkim \
    opendkim-tools \
    postgresql-client \
    netcat-openbsd \
    openssl \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -u 10001 opendkim \
    && mkdir -p /var/lib/opendkim/keys /var/run/opendkim \
    && chown -R opendkim:opendkim /var/lib/opendkim /var/run/opendkim

COPY opendkim.conf /etc/opendkim.conf
COPY TrustedHosts /etc/opendkim/TrustedHosts
COPY entrypoint.sh /entrypoint.sh
# OpenDKIM drops privileges after startup and reloads InternalHosts at runtime.
# The packaged directory is not traversable by the service account by default.
RUN chown root:opendkim /etc/opendkim /etc/opendkim/TrustedHosts \
    && chmod 0750 /etc/opendkim \
    && chmod 0640 /etc/opendkim/TrustedHosts \
    && chmod +x /entrypoint.sh

EXPOSE 8891
ENTRYPOINT ["/entrypoint.sh"]
