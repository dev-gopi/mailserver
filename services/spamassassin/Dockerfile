FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Apache SpamAssassin 4.0.2 is newer than Ubuntu 24.04's packaged 4.0.0.
# Keep the upstream source and checksum pinned so image rebuilds are
# reproducible and the downloaded release is integrity-checked.
ARG SPAMASSASSIN_VERSION=4.0.2
ARG SPAMASSASSIN_SHA512=138ba8c4577173d0584d44757397af335e45d0f04a66834ef84c2a9065f33aec8f71c1685c6849ad048998915dd7bd1e6cb7e8be8363ef3652d695e15736aab6

RUN apt-get update && apt-get install -y --no-install-recommends \
    spamassassin \
    ca-certificates \
    build-essential \
    spamd \
    libmail-spamassassin-perl \
    cron \
    tzdata \
    curl \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLO "https://downloads.apache.org/spamassassin/source/Mail-SpamAssassin-${SPAMASSASSIN_VERSION}.tar.gz" \
    && echo "${SPAMASSASSIN_SHA512}  Mail-SpamAssassin-${SPAMASSASSIN_VERSION}.tar.gz" | sha512sum -c - \
    && tar -xzf "Mail-SpamAssassin-${SPAMASSASSIN_VERSION}.tar.gz" \
    && cd "Mail-SpamAssassin-${SPAMASSASSIN_VERSION}" \
    && perl Makefile.PL INSTALLDIRS=site --sysconfdir=/etc/spamassassin \
    && make \
    && make install \
    && cd / \
    && rm -rf "Mail-SpamAssassin-${SPAMASSASSIN_VERSION}" "Mail-SpamAssassin-${SPAMASSASSIN_VERSION}.tar.gz" \
    && apt-get purge -y --auto-remove build-essential

# Create spamd user and group with UID/GID 5000
RUN groupadd -g 5000 spamd && \
    useradd -u 5000 -g spamd -d /home/spamd -s /usr/sbin/nologin -c "" spamd

# Create necessary directories and set permissions
RUN mkdir -p /home/spamd /var/log/spamassassin /var/run && \
    chown -R spamd:spamd /home/spamd /var/log/spamassassin && \
    touch /var/run/spamd.pid && chown spamd:spamd /var/run/spamd.pid

# Optional: backup the original SpamAssassin config
RUN mv /etc/spamassassin/local.cf /etc/spamassassin/local.cf.bk

# Copy your custom SpamAssassin default config
COPY config/spamassassin /etc/default/spamassassin
COPY config/local.cf /etc/spamassassin/local.cf

COPY config/sa-learn-cron /etc/cron.daily/sa-learn-cron
RUN chmod +x /etc/cron.daily/sa-learn-cron

# Create spamd log file and set permissions
RUN touch /home/spamd/spamd.log && chown spamd:spamd /home/spamd/spamd.log

EXPOSE 783 11332

# CMD ["spamd", "-c", "-m5", "--nouser-config", "--syslog-socket=none", "--listen=0.0.0.0", "--allowed-ips=172.16.0.0/12", "--port=783", "--pidfile=/var/run/spamd.pid", "--username", "spamd", "--helper-home-dir", "/home/spamd/", "-s", "/home/spamd/spamd.log"]

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
