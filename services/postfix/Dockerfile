FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    postfix \
    postfix-pgsql \
    rsyslog \
    libsasl2-modules \
    libsasl2-modules-db \
    ca-certificates \
    spamc \
    openssl \
    net-tools \
    socat \
    telnet \
    nano \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY rsyslog-container.conf /etc/rsyslog-container.conf

RUN groupadd -g 5000 vmail && \
    useradd -u 5000 -g vmail -d /var/mail -s /usr/sbin/nologin vmail

RUN mv /etc/postfix/main.cf /etc/postfix/main.cf.bk
RUN mv /etc/postfix/master.cf /etc/postfix/master.cf.bk

COPY main.cf /etc/postfix/main.cf
COPY master.cf /etc/postfix/master.cf
COPY config/pgsql-virtual-users.cf /etc/postfix/pgsql-virtual-users.cf
COPY config/pgsql-virtual-domains.cf /etc/postfix/pgsql-virtual-domains.cf
COPY config/pgsql-virtual-aliases.cf /etc/postfix/pgsql-virtual-aliases.cf
RUN chown root:root /etc/postfix/main.cf /etc/postfix/master.cf \
    && chown root:postfix /etc/postfix/pgsql-virtual-*.cf \
    && chmod 0640 /etc/postfix/main.cf /etc/postfix/master.cf /etc/postfix/pgsql-virtual-*.cf

VOLUME ["/var/mail"]

EXPOSE 25 587 465

# CMD ["postfix", "start-fg"]

COPY entrypoint.sh /entrypoint.sh
COPY postfix-bridge.sh /usr/local/bin/postfix-bridge.sh
RUN chmod +x /entrypoint.sh
RUN chmod 750 /usr/local/bin/postfix-bridge.sh && chown root:root /usr/local/bin/postfix-bridge.sh

CMD ["/entrypoint.sh"]
