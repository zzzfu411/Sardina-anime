#!/bin/zsh
set -e
TASK_ROOT="${0:A:h}"
cd "$TASK_ROOT"
if [[ -x "$TASK_ROOT/.tooling/node/bin/node" ]]; then
  export PATH="$TASK_ROOT/.tooling/node/bin:$PATH"
fi
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  print '请先安装 Node.js 24。详见 README.md。'
  read -k 1
  exit 1
fi
if [[ ! -d node_modules ]]; then
  print '请先在这个目录执行 pnpm install，再执行 pnpm build。'
  read -k 1
  exit 1
fi
if [[ ! -f dist/engine/cli.js ]]; then
  pnpm build
fi
exec node dist/engine/cli.js --open
