FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt update && \
    DEBIAN_FRONTEND=noninteractive apt install -y --no-install-recommends \
    dovecot-core \
    dovecot-imapd \
    dovecot-lmtpd \
    dovecot-pop3d \
    dovecot-pgsql \
    dovecot-sieve \
    dovecot-managesieved \
    ca-certificates \
    nano \
    file \
    openssl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN groupadd -g 5000 vmail && \
    useradd -u 5000 -g vmail -d /var/mail -s /usr/sbin/nologin vmail

COPY config/dovecot-sql.conf.ext /etc/dovecot/dovecot-sql.conf.ext
COPY local.conf /etc/dovecot/local.conf
COPY config/spam.sieve /var/mail/sieve/spam.sieve

RUN mkdir -p /var/mail/sieve && \
    chown -R vmail:vmail /var/mail/sieve && \
    chmod 755 /var/mail/sieve && \
    chmod 644 /var/mail/sieve/spam.sieve && \
    sievec /var/mail/sieve/spam.sieve /var/mail/sieve/spam.svbin && \
    chown vmail:vmail /var/mail/sieve/spam.svbin

VOLUME ["/var/mail"]

EXPOSE 143 993 110 995 24

# CMD ["dovecot", "-F"]

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
