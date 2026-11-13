FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    amavisd-new \
    clamav-base \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN echo "mail.local" > /etc/mailname

# This image is intentionally not part of the default Compose stack.  Keep the
# configuration here so it is ready if Amavis is enabled deliberately later.
COPY conf.d/50-user /etc/amavis/conf.d/50-user

EXPOSE 10024 10026

CMD ["amavisd-new", "foreground"]
