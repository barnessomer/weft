#!/bin/sh
# Print the tool versions baked into the image (used by the live smoke test).
printf 'node %s\n' "$(node --version)"
printf 'git %s\n' "$(git --version | cut -d' ' -f3)"
printf 'claude %s\n' "$(claude --version 2>/dev/null | head -1)"
printf 'codex %s\n' "$(codex --version 2>/dev/null | head -1)"
printf 'mergiraf %s\n' "$(mergiraf --version 2>/dev/null | head -1)"
printf 'pnpm %s\n' "$(pnpm --version 2>/dev/null)"
printf 'weft-adapter-claude %s\n' "$(test -f /opt/weft/adapters/claude-code/dist/weft-claude.mjs && node -e 'console.log(require("/opt/weft/adapters/claude-code/package.json").version)')"
printf 'typescript %s\n' "$(node -e 'console.log(require("/opt/weft/adapters/claude-code/node_modules/typescript/package.json").version)' 2>/dev/null)"
