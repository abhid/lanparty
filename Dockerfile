# syntax=docker/dockerfile:1.7

FROM golang:1.22 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -ldflags="-s -w" -o /out/lanparty ./cmd/lanparty

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /data
COPY --from=build /out/lanparty /usr/local/bin/lanparty
ENV LANPARTY_ROOT=/data \
    LANPARTY_STATE_DIR=/data/.lanparty \
    LANPARTY_ADDR=0.0.0.0:3923
EXPOSE 3923
ENTRYPOINT ["lanparty"]
CMD []

