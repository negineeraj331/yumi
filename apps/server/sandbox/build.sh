#!/usr/bin/env sh
#
# Build the sandbox images that carry a debugger.
#
# C++, Go and Rust are the three languages whose official images ship no
# debugger at all, and a session runs with `--network none`, so one cannot be
# fetched at run time — it has to be in the image. Each of these is the stock
# image the runner already uses plus that language's debugger and nothing else.
#
#   pnpm --filter @yumi/server sandbox:build
#
# Running, testing and profiling continue to use the stock images: only
# debugging pays for the extra weight.
set -eu

cd "$(dirname "$0")"

for lang in cpp go rust; do
  echo "==> yumi-sandbox-$lang:1"
  docker build -f "Dockerfile.$lang" -t "yumi-sandbox-$lang:1" .
done

echo
echo "Built:"
docker images --filter "reference=yumi-sandbox-*" --format "  {{.Repository}}:{{.Tag}}  {{.Size}}"
