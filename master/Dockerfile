FROM golang:1.23-alpine AS builder

WORKDIR /src/master
COPY master/go.mod master/go.sum ./
RUN go mod download

COPY master/ ./
COPY version.json /src/version.json
RUN PRODUCT_VERSION="$(go run ./cmd/capown-version --manifest /src/version.json --field product_version)" && \
    PROTOCOL_VERSION="$(go run ./cmd/capown-version --manifest /src/version.json --field protocol_version)" && \
    CGO_ENABLED=0 go build \
      -ldflags "-X github.com/capown/master/internal/version.ProductVersion=${PRODUCT_VERSION} -X github.com/capown/master/internal/version.ProtocolVersion=${PROTOCOL_VERSION}" \
      -o /capown-master ./cmd/capown-master

FROM alpine:3.19
ARG CAPOWN_PRODUCT_VERSION
ARG CAPOWN_PROTOCOL_VERSION
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /capown-master /usr/local/bin/capown-master
COPY master/config.toml.example /opt/capown/config.toml.example
COPY master/docker-entrypoint.sh /usr/local/bin/capown-entrypoint
RUN chmod +x /usr/local/bin/capown-entrypoint
LABEL org.opencontainers.image.title="CapOwn Master" \
      org.opencontainers.image.version="${CAPOWN_PRODUCT_VERSION}" \
      org.opencontainers.image.description="CapOwn Master implementing protocol ${CAPOWN_PROTOCOL_VERSION}"
EXPOSE 9230

ENTRYPOINT ["/usr/local/bin/capown-entrypoint"]
