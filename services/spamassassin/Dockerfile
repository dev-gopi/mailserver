FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    spamassassin \
    libmail-spamassassin-perl \
    cron \
    curl \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

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
