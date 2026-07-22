ARG GO_IMAGE=golang:1.23-alpine
ARG ALPINE_IMAGE=alpine:3.19
ARG ALPINE_MIRROR=""
ARG GOPROXY=https://proxy.golang.org,direct

FROM ${GO_IMAGE} AS builder

ARG GOPROXY

WORKDIR /src/master
COPY master/go.mod master/go.sum ./
RUN GOPROXY="${GOPROXY}" go mod download

COPY master/ ./
COPY version.json /src/version.json
RUN MASTER_VERSION="$(go run ./cmd/capown-version --manifest /src/version.json --field master_version)" && \
    PROTOCOL_VERSION="$(go run ./cmd/capown-version --manifest /src/version.json --field protocol_version)" && \
    CGO_ENABLED=0 go build \
      -ldflags "-X github.com/capown/master/internal/version.MasterVersion=${MASTER_VERSION} -X github.com/capown/master/internal/version.ProtocolVersion=${PROTOCOL_VERSION}" \
      -o /capown-master ./cmd/capown-master

FROM ${ALPINE_IMAGE}
ARG CAPOWN_MASTER_VERSION=dev
ARG CAPOWN_PROTOCOL_VERSION=dev
ARG CAPOWN_RELEASE_TAG=dev
ARG ALPINE_MIRROR
RUN if [ -n "${ALPINE_MIRROR}" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi && \
    apk add --no-cache ca-certificates tzdata
COPY --from=builder /capown-master /usr/local/bin/capown-master
COPY master/config.toml.example /opt/capown/config.toml.example
COPY registry/ /opt/capown/registry/
COPY master/docker-entrypoint.sh /usr/local/bin/capown-entrypoint
RUN chmod +x /usr/local/bin/capown-entrypoint
LABEL org.opencontainers.image.title="CapOwn Master" \
      org.opencontainers.image.version="${CAPOWN_MASTER_VERSION}" \
      org.opencontainers.image.ref.name="${CAPOWN_RELEASE_TAG}" \
      org.opencontainers.image.description="CapOwn Master implementing protocol ${CAPOWN_PROTOCOL_VERSION}"
EXPOSE 9230

ENTRYPOINT ["/usr/local/bin/capown-entrypoint"]
