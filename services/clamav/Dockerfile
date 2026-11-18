FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    clamav \
    clamav-daemon \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/run/clamav /var/lib/clamav /var/log/clamav && \
    chown clamav:clamav /var/run/clamav /var/lib/clamav /var/log/clamav

COPY clamd.conf /etc/clamav/clamd.conf
COPY freshclam.conf /etc/clamav/freshclam.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3310

# CMD ["clamd", "-F"]

ENTRYPOINT ["/entrypoint.sh"]
