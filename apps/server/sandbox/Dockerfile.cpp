# Sandbox image for C++ debugging.
#
# Built from the same `gcc:14` the runner already uses, adding only Debian's own
# gdb. The runner keeps using the stock image: nothing about running, testing or
# profiling changes, so the extra weight is paid only where it buys something.
#
# This exists because `--network none` (rules.md §3.5) means a debugger cannot be
# fetched when a session starts — it has to be in the image or it is not there at
# all, which is what blocked C++/Go/Rust debugging until now.
FROM gcc:14

RUN apt-get update \
 && apt-get install -y --no-install-recommends gdb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Fail the build rather than ship an image whose whole purpose is missing.
# stdbuf is used as gdb's exec-wrapper so the debuggee's output streams live.
RUN gdb --version > /dev/null && stdbuf --version > /dev/null
