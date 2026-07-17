FROM golang:1.23-alpine AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o /capown-master ./cmd/capown-master

FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /capown-master /usr/local/bin/capown-master
COPY config.toml.example /opt/capown/config.toml.example
COPY docker-entrypoint.sh /usr/local/bin/capown-entrypoint
RUN chmod +x /usr/local/bin/capown-entrypoint
EXPOSE 9210

ENTRYPOINT ["/usr/local/bin/capown-entrypoint"]
