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
      case ":$PATH:" in
        *":$node_bin:"*) ;;
        *) export PATH="$node_bin:$PATH" ;;
      esac
    fi
  fi
fi
