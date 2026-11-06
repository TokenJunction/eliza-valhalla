$ErrorActionPreference = 'Stop'

# Windows entry for the customer smoke. It does not install software, open a
# tunnel, change this PC, or write a file. Set the variables in the shell first.

if ($args.Count -ne 1 -or ($args[0] -ne 'local-qwen' -and $args[0] -ne 'preview')) {
  throw 'Usage: .\install-smoke.ps1 local-qwen|preview. This script does not install software, open a tunnel, or write files.'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 22 or newer is required. This script does not download Node and does not change this PC.'
}

$smoke = Join-Path $PSScriptRoot 'smoke.mjs'
if (-not (Test-Path -LiteralPath $smoke)) {
  throw 'customer\smoke.mjs is missing beside this installer.'
}

& node $smoke $args[0]
exit $LASTEXITCODE
