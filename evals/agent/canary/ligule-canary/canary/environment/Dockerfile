FROM alexgshaw/fix-git@sha256:61e431c00c58df652287aadce5457634d9f9330cfdd153ebdf2802df0d540119

ADD --checksum=sha256:361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9 https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.gz /tmp/node-v24.22.2-linux-x64.tar.gz
RUN mkdir -p /opt/node-v24.22.2 \
    && tar --no-same-owner -xzf /tmp/node-v24.22.2-linux-x64.tar.gz --strip-components=1 -C /opt/node-v24.22.2 \
    && rm /tmp/node-v24.22.2-linux-x64.tar.gz
ENV PATH="/opt/node-v24.22.2/bin:${PATH}"

WORKDIR /app

RUN mkdir -p /app
