FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    opendkim \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -u 10001 opendkim \
    && mkdir -p /var/lib/opendkim/keys /var/run/opendkim \
    && chown -R opendkim:opendkim /var/lib/opendkim /var/run/opendkim

COPY opendkim.conf /etc/opendkim.conf
COPY TrustedHosts /etc/opendkim/TrustedHosts
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8891
ENTRYPOINT ["/entrypoint.sh"]
