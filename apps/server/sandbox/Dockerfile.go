# Sandbox image for Go debugging.
#
# Go's debugger is Delve rather than gdb — gdb understands Go poorly enough that
# goroutine-aware stepping is not really usable. Delve is a Go program, so it is
# built here at image-build time (where there IS a network) and baked in, because
# a session runs with `--network none` and can fetch nothing.
#
# GOFLAGS/GOCACHE below matter at *run* time: a sandboxed build with no writable
# HOME fails on a cache it cannot create, and the failure reads as a compiler
# error rather than a configuration one.
FROM golang:1.23-alpine

RUN apk add --no-cache git \
 && go install github.com/go-delve/delve/cmd/dlv@v1.23.1 \
 && apk del git

ENV GOFLAGS=-buildvcs=false \
    GOCACHE=/tmp/gocache \
    GOPATH=/tmp/gopath \
    CGO_ENABLED=0

WORKDIR /work

RUN dlv version > /dev/null
