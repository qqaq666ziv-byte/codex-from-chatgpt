[CmdletBinding()]
param(
  [Parameter(Position=0)][ValidateSet('setup','run','status','approve','deny','stop','help')][string]$Action='help',
  [string]$RequestId,
  [string]$VerificationCode
)
$ErrorActionPreference='Stop'
$AutoDevRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$AutoDevEntry=Join-Path $AutoDevRoot 'dist/src/gateway-runner.js'
if (-not (Test-Path -LiteralPath $AutoDevEntry)) { throw 'Build AutoDev before configuring a connection.' }
$AutoDevNode=(Get-Command node.exe -ErrorAction Stop).Source
$AutoDevArgs=@($AutoDevEntry,$Action)
if($Action -eq 'run') {$AutoDevArgs+=('--autodev-gateway-instance='+[guid]::NewGuid().ToString())}
if($Action -in @('approve','deny')) {
  if([string]::IsNullOrWhiteSpace($RequestId) -or [string]::IsNullOrWhiteSpace($VerificationCode)) {throw 'Both RequestId and VerificationCode are required.'}
  $AutoDevArgs+=@($RequestId,$VerificationCode)
}
& $AutoDevNode @AutoDevArgs
exit $LASTEXITCODE
