#!/usr/bin/env bash
# Select a Node.js runtime that satisfies package.json engines (>=22.19.0).
# The base image ships an older node on PATH (/exec-daemon/node), so prefer the
# nvm-managed default when it is available. Falls back to the base node otherwise.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  if command -v nvm >/dev/null 2>&1; then
    node_bin="$(dirname "$(nvm which default 2>/dev/null)" 2>/dev/null)"
    if [ -n "$node_bin" ] && [ -x "$node_bin/node" ]; then
      # The base image ships an older node earlier in PATH (/exec-daemon/node) and
      # may already include this nvm bin later in PATH. Rebuild PATH without any
      # existing occurrence, then prepend it, so the compliant node always wins.
      new_path=""
      old_ifs="$IFS"
      IFS=":"
      for entry in $PATH; do
        [ "$entry" = "$node_bin" ] && continue
        if [ -z "$new_path" ]; then new_path="$entry"; else new_path="$new_path:$entry"; fi
      done
      IFS="$old_ifs"
      export PATH="$node_bin:$new_path"
    fi
  fi
fi
