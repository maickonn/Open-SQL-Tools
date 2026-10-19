# Firebird 2.5.9 SuperServer. There is no maintained official image for 2.5,
# so this unpacks the official release tarball (its buildroot) directly.
FROM debian:bookworm-slim

ARG FB_URL=https://github.com/FirebirdSQL/firebird/releases/download/R2_5_9/FirebirdSS-2.5.9.27139-0.amd64.tar.gz

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libncurses5 libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl -fsSL "$FB_URL" -o /tmp/fb.tar.gz; \
    mkdir /tmp/fb; \
    tar xzf /tmp/fb.tar.gz -C /tmp/fb --strip-components=1; \
    tar xzf /tmp/fb/buildroot.tar.gz -C /; \
    rm -rf /tmp/fb /tmp/fb.tar.gz; \
    test -x /opt/firebird/bin/fbserver; \
    mkdir -p /var/lib/firebird/data

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV PATH=/opt/firebird/bin:$PATH
EXPOSE 3050
ENTRYPOINT ["/entrypoint.sh"]
