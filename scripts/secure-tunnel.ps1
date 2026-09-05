[CmdletBinding()]
param(
  [Parameter(Position=0)][ValidateSet('setup','configure','credential','start','run','status','doctor','stop','restart','help')][string]$Action='help',
  [string]$TunnelId,
  [ValidateRange(1024,65534)][int]$HealthPort=8796,
  [string]$ZeroCostEvidenceUrl,
  [switch]$ConfirmZeroAddedCost,
  [ValidateSet('free-service','free-tier','free-credits')][string]$CostBasis='free-service',
  [string]$EvidenceExpiresAt
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'local-common.ps1')
$AutoDevRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$AutoDevRuntime=Join-Path $AutoDevRoot '.runtime'
$AutoDevEntry=Join-Path $AutoDevRoot 'dist\src\secure-tunnel-runner.js'
$AutoDevNode=(Get-Command node.exe -ErrorAction Stop).Source
function Invoke-SecureCommand([string[]]$Values) {
  & $AutoDevNode $AutoDevEntry @Values
  Assert-AutoDevExit 'Secure Tunnel operation' $LASTEXITCODE
}
try {
  if (-not (Test-Path -LiteralPath $AutoDevEntry -PathType Leaf)) { throw 'Build the selected AutoDev source before using its Secure Tunnel launcher.' }
  if ($Action -in @('setup','configure','credential','start','run','restart')) { Protect-AutoDevRuntime $AutoDevRuntime }
  if ($Action -eq 'configure') {
    if ([string]::IsNullOrWhiteSpace($TunnelId)) { throw 'Provide the existing Tunnel ID locally; do not create a replacement tunnel.' }
    if ([bool]$ConfirmZeroAddedCost -ne (-not [string]::IsNullOrWhiteSpace($ZeroCostEvidenceUrl))) { throw 'Provide both explicit zero-added-cost confirmation and its official evidence URL, or neither.' }
    $Values=@('configure',$TunnelId,[string]$HealthPort)
    # Confirmation covers no new payment method, no charges/upgrade/recharge/
    # purchases, and provider-enforced stop at quota exhaustion. It does not
    # assert the entire service is permanently free.
    if ($ConfirmZeroAddedCost) { $Values+=@($ZeroCostEvidenceUrl,'confirmed',$CostBasis,$EvidenceExpiresAt) }
    Invoke-SecureCommand $Values
    return
  }
  if ($Action -eq 'credential') {
    # Cost validation precedes the credential prompt. The assistant never asks
    # for a key in chat; this is an operator-only local SecureString prompt.
    Invoke-SecureCommand @('credential-check')
    $SecureValue=Read-Host 'Existing restricted Tunnel runtime key (input hidden)' -AsSecureString
    try {
      if ($SecureValue.Length -lt 20 -or $SecureValue.Length -gt 515) { throw 'Invalid runtime key length; no credential saved.' }
      $Encrypted=ConvertFrom-SecureString -SecureString $SecureValue
      $Encrypted | & $AutoDevNode $AutoDevEntry credential-store
      Assert-AutoDevExit 'Saving the encrypted Tunnel credential under the lifecycle lock' $LASTEXITCODE
      Protect-AutoDevRuntime $AutoDevRuntime
      Write-Output 'Runtime key stored with Windows current-user DPAPI and private ACL. It is not a model API credential for Codex.'
    } finally { $SecureValue.Dispose(); $Encrypted=$null }
    return
  }
  if ($Action -eq 'restart') { Invoke-SecureCommand @('stop'); $Action='start' }
  if ($Action -eq 'start') {
    $Current=& $AutoDevNode $AutoDevEntry status
    Assert-AutoDevExit 'Checking Secure Tunnel process ownership' $LASTEXITCODE
    $CurrentStatus=$Current | ConvertFrom-Json
    if ($CurrentStatus.process_running -eq $true) { $Current; return }
    Invoke-SecureCommand @('credential-check')
    $Instance=[Guid]::NewGuid().ToString()
    $Values=@($AutoDevEntry,'run',"--autodev-secure-instance=$Instance")
    $Arguments=($Values | ForEach-Object { ConvertTo-AutoDevNativeArgument $_ }) -join ' '
    $Child=Start-Process -FilePath $AutoDevNode -ArgumentList $Arguments -WorkingDirectory $AutoDevRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $AutoDevRuntime "secure-$Instance.stdout.log") -RedirectStandardError (Join-Path $AutoDevRuntime "secure-$Instance.stderr.log")
    $Deadline=[DateTime]::UtcNow.AddSeconds(30)
    do {
      $Child.Refresh()
      if ($Child.HasExited) { throw "Secure Tunnel supervisor exited during startup (exit $($Child.ExitCode)). Run doctor; check the existing core/OAuth gateway and local credential. No remote success was inferred." }
      $RecordFile=Join-Path $AutoDevRuntime 'secure-tunnel-process.json'
      if (Test-Path -LiteralPath $RecordFile -PathType Leaf) {
        $Record=Get-Content -LiteralPath $RecordFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($Record.instance -eq $Instance -and $Record.pid -eq $Child.Id) {
          Invoke-SecureCommand @('status')
          Write-Output 'Supervisor launched. Local readiness and successful polling are separate from ordinary ChatGPT acceptance.'
          return
        }
      }
      Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw 'Supervisor launch was not confirmed within 30 seconds. Use status before retrying; no second supervisor was launched.'
  }
  if ($Action -eq 'run') { Invoke-SecureCommand @('run',('--autodev-secure-instance='+[Guid]::NewGuid().ToString())); return }
  Invoke-SecureCommand @($Action)
} catch { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
