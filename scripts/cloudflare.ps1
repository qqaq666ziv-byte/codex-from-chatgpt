param([ValidateSet('login','status','deploy')][string]$Action = 'status', [switch]$ConfirmWorkersFree)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-common.ps1')
$TaskProductRoot = Split-Path -Parent $PSScriptRoot
$TaskPrivateCli = Join-Path $TaskProductRoot '.runtime\cloudflare-cli'
Protect-AutoDevRuntime $TaskPrivateCli
$TaskWrangler = Join-Path $TaskProductRoot 'edge\node_modules\wrangler\bin\wrangler.js'
if (-not (Test-Path -LiteralPath $TaskWrangler -PathType Leaf)) { throw 'Install the pinned deployment tool with npm.cmd ci --prefix edge --no-audit --no-fund.' }
if ($Action -eq 'deploy') {
  if (-not $ConfirmWorkersFree) { throw 'COST_UNVERIFIED: verify this account is Workers Free, requires no new payment method, and has no automatic charges, paid upgrade, recharge or purchase. Quota exhaustion must stop.' }
  & node.exe (Join-Path $PSScriptRoot 'cloudflare-setup.mjs') --confirmed-workers-free
} else { & node.exe (Join-Path $PSScriptRoot 'cloudflare-cli.mjs') $Action }
Assert-AutoDevExit 'Cloudflare operation' $LASTEXITCODE
