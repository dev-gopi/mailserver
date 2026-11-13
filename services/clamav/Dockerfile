FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt update && apt install -y \
    clamav \
    clamav-daemon \
    clamsmtp \
    clamav-milter \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/run/clamav /var/lib/clamav /var/log/clamav && \
    chown clamav:clamav /var/run/clamav /var/lib/clamav /var/log/clamav

COPY clamsmtpd.conf /etc/clamsmtpd.conf
COPY clamd.conf /etc/clamav/clamd.conf
COPY freshclam.conf /etc/clamav/freshclam.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3310 10026

# CMD ["clamd", "-F"]

ENTRYPOINT ["/entrypoint.sh"]
