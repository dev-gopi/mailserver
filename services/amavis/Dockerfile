FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt update && apt install -y \
    amavisd-new \
    clamav-base \
    && rm -rf /var/lib/apt/lists/*

RUN echo "mail.local" > /etc/mailname

EXPOSE 10024 10026

CMD ["amavisd-new", "foreground"]
