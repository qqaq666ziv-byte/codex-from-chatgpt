[CmdletBinding()]
param(
  [Parameter(Position=0)][ValidateSet('setup','configure','credential','start','run','status','doctor','stop','restart','approve','deny','connection-info','help')][string]$Action='help',
  [Parameter(Position=1)][string]$RequestId,
  [Parameter(Position=2)][string]$VerificationCode,
  [string]$WorkerOrigin,
  [string]$EvidenceUrl,
  [ValidateSet('free-service','free-tier','free-credits')][string]$CostBasis='free-tier',
  [string]$CostExpiresAt,
  [switch]$ConfirmAccountPlan,
  [switch]$ConfirmNoNewPaymentMethod,
  [switch]$ConfirmNoAutomaticCharges,
  [switch]$ConfirmNoPaidUpgrade,
  [switch]$ConfirmQuotaStops,
  [switch]$ConfirmNoAutoRecharge,
  [switch]$ConfirmNoPurchases
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'local-common.ps1')
$AutoDevRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$AutoDevRuntime=Join-Path $AutoDevRoot '.runtime'
$AutoDevEntry=Join-Path $AutoDevRoot 'dist\src\fixed-tunnel-runner.js'
$AutoDevNode=(Get-Command node.exe -ErrorAction Stop).Source
function Invoke-FixedCommand([string[]]$Values) {
  & $AutoDevNode $AutoDevEntry @Values
  Assert-AutoDevExit 'Fixed Cloudflare connection operation' $LASTEXITCODE
}
try {
  if (-not(Test-Path -LiteralPath $AutoDevEntry -PathType Leaf)) { throw 'Build the selected AutoDev source before using its fixed connection launcher.' }
  if ($Action -in @('setup','configure','credential','start','run','restart')) { Protect-AutoDevRuntime $AutoDevRuntime }
  if ($Action -eq 'configure') {
    if ([string]::IsNullOrWhiteSpace($WorkerOrigin)) { throw 'Provide the existing exact HTTPS workers.dev origin.' }
    $Checks=@([bool]$ConfirmAccountPlan,[bool]$ConfirmNoNewPaymentMethod,[bool]$ConfirmNoAutomaticCharges,[bool]$ConfirmNoPaidUpgrade,[bool]$ConfirmQuotaStops,[bool]$ConfirmNoAutoRecharge,[bool]$ConfirmNoPurchases)
    $Count=@($Checks | Where-Object { $_ }).Count
    $Payload=@{origin=$WorkerOrigin}
    if ($Count -gt 0 -or -not[string]::IsNullOrWhiteSpace($EvidenceUrl) -or -not[string]::IsNullOrWhiteSpace($CostExpiresAt)) {
      if ($Count -ne 7 -or [string]::IsNullOrWhiteSpace($EvidenceUrl)) { throw 'Confirm the account plan and all six no-charge safeguards together with their current official evidence.' }
      $Evidence=@{evidenceUrl=$EvidenceUrl;basis=$CostBasis;accountPlanConfirmed=$true;safeguards=@{newPaymentMethodRequired=$false;automaticCharges=$false;automaticPaidUpgrade=$false;quotaExhaustion='stop';autoRecharge=$false;purchases=$false}}
      if (-not[string]::IsNullOrWhiteSpace($CostExpiresAt)) { $Evidence.expiresAt=$CostExpiresAt }
      $Payload.evidence=$Evidence
    }
    ($Payload | ConvertTo-Json -Depth 6 -Compress) | & $AutoDevNode $AutoDevEntry configure
    Assert-AutoDevExit 'Saving fixed connection configuration' $LASTEXITCODE
    return
  }
  if ($Action -eq 'credential') {
    Invoke-FixedCommand @('credential-check')
    $Secret=Read-Host 'Existing Worker route control secret (43-128 base64url characters; input hidden)' -AsSecureString
    try {
      if ($Secret.Length -lt 43 -or $Secret.Length -gt 128) { throw 'Invalid route control secret length. No credential saved.' }
      $Encrypted=ConvertFrom-SecureString -SecureString $Secret
      $Encrypted | & $AutoDevNode $AutoDevEntry credential-store
      Assert-AutoDevExit 'Saving the DPAPI route credential under its lifecycle lease' $LASTEXITCODE
      Protect-AutoDevRuntime $AutoDevRuntime
      Write-Output 'Route control secret stored with current-user DPAPI. Native cloudflared receives no credential.'
    } finally { $Secret.Dispose(); $Encrypted=$null }
    return
  }
  if ($Action -eq 'restart') { Invoke-FixedCommand @('stop'); $Action='start' }
  if ($Action -eq 'start') {
    $Current=& $AutoDevNode $AutoDevEntry status
    Assert-AutoDevExit 'Checking fixed gateway ownership' $LASTEXITCODE
    if (($Current | ConvertFrom-Json).process_running -eq $true) { $Current; return }
    Invoke-FixedCommand @('credential-check')
    $Instance=[Guid]::NewGuid().ToString()
    $Values=@($AutoDevEntry,'run',"--autodev-fixed-instance=$Instance")
    $Arguments=($Values | ForEach-Object { ConvertTo-AutoDevNativeArgument $_ }) -join ' '
    $Child=Start-Process -FilePath $AutoDevNode -ArgumentList $Arguments -WorkingDirectory $AutoDevRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $AutoDevRuntime "fixed-$Instance.stdout.log") -RedirectStandardError (Join-Path $AutoDevRuntime "fixed-$Instance.stderr.log")
    $Deadline=[DateTime]::UtcNow.AddSeconds(240)
    do {
      $Child.Refresh()
      if ($Child.HasExited) { throw "Fixed gateway exited during startup (exit $($Child.ExitCode)). Run doctor and check core, Worker route secret and free quota. No connection success was inferred." }
      $RecordFile=Join-Path $AutoDevRuntime 'fixed-gateway-process.json'
      if (Test-Path -LiteralPath $RecordFile -PathType Leaf) {
        $Record=Get-Content -LiteralPath $RecordFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($Record.instance -eq $Instance -and $Record.pid -eq $Child.Id -and $Record.startupConfirmed -eq $true) {
          Invoke-FixedCommand @('status')
          Write-Output 'This run of the encrypted relay was confirmed. Ordinary ChatGPT acceptance remains separate.'
          return
        }
      }
      Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw 'Fixed gateway launch was not confirmed within four minutes. Use status before retrying; no second supervisor was launched.'
  }
  if ($Action -eq 'run') { Invoke-FixedCommand @('run',('--autodev-fixed-instance='+[Guid]::NewGuid().ToString())); return }
  if ($Action -in @('approve','deny')) {
    if ([string]::IsNullOrWhiteSpace($RequestId) -or [string]::IsNullOrWhiteSpace($VerificationCode)) { throw 'Provide the matching request ID and verification code from the OAuth page.' }
    Invoke-FixedCommand @($Action,$RequestId,$VerificationCode)
    return
  }
  Invoke-FixedCommand @($Action)
} catch { Write-Error $_.Exception.Message -ErrorAction Continue; exit 1 }
