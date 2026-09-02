#!/bin/sh
# A host NODE_ENV=development must not turn the packaged application into a
# development build. Development-only modules are intentionally not packaged.
export NODE_ENV=production

# Only pass --download when a parameter %u is provided (nxm:// links from browser).
# This matches Windows behaviour, which includes --download on all protocol handler calls,
# but does not on non-handler calls (e.g., when starting from the start menu).
if [ -n "$1" ]; then
  exec zypak-wrapper /app/main/vortex --download "$@"
else
  exec zypak-wrapper /app/main/vortex
fi
