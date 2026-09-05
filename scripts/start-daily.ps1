[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$TaskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$TaskExit = 1
$TaskMutex = $null
$TaskOwnsMutex = $false

function Invoke-DailyScript([string]$File, [string[]]$Values) {
  # Isolated PowerShell makes a child script's exit code authoritative. Capture
  # its output: core status may contain private work and is not a daily summary.
  $TaskSavedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $global:LASTEXITCODE = 1
    $TaskLines = @(& $TaskShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $File @Values 2>&1)
    $TaskCode = $global:LASTEXITCODE
  } finally { $ErrorActionPreference = $TaskSavedPreference }
  return [pscustomobject]@{ Code = $TaskCode; Text = ($TaskLines -join "`n") }
}

try {
  $TaskShell = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
  $TaskNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  foreach ($TaskRelative in @('autodev.ps1', 'fixed-tunnel.ps1', 'local-common.ps1', 'backup-common.ps1')) {
    $TaskItem = Get-Item -LiteralPath (Join-Path $PSScriptRoot $TaskRelative) -Force -ErrorAction Stop
    if ($TaskItem.PSIsContainer -or ($TaskItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '啟動腳本必須是本工作區的實體檔案。' }
  }
  $TaskHasher = [Security.Cryptography.SHA256]::Create()
  try { $TaskDigest = [BitConverter]::ToString($TaskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($TaskRoot.ToLowerInvariant()))).Replace('-', '') }
  finally { $TaskHasher.Dispose() }
  $TaskMutex = New-Object Threading.Mutex($false, ("Global\AutoDev-Daily-" + $TaskDigest))
  try { $TaskOwnsMutex = $TaskMutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $TaskOwnsMutex = $true }
  if (-not $TaskOwnsMutex) { throw '此工作區已有一鍵啟動正在執行，請等待該視窗完成。' }

  Write-Output '檢查既有安裝、成本證據與未完成狀態；不會安裝或部署。'
  # This is read-only preflight. Use the same cost/config/hash implementation as
  # the real runner, without decrypting credentials or contacting a provider.
  $TaskPreflight = @'
import { lstatSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error();
  const root = process.argv[2], runtime = path.join(root, '.runtime');
  for (const name of ['.runtime', '.tools', 'dist', 'dist/src']) {
    const entry = lstatSync(path.join(root, name));
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error();
  }
  for (const name of ['build-incomplete.json', 'fixed-deploy-incomplete.json', 'fixed-oauth.dpapi.pending']) {
    if (existsSync(path.join(runtime, name))) throw new Error();
  }
  for (const name of ['config.json', 'admin-token', 'client-token', 'fixed-tunnel.json', 'fixed-tunnel-key.dpapi']) {
    const entry = lstatSync(path.join(runtime, name));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) throw new Error();
  }
  for (const name of ['index.js', 'fixed-tunnel-runner.js', 'fixed-tunnel.js', 'local-config.js']) {
    const entry = lstatSync(path.join(root, 'dist', 'src', name));
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error();
  }
  const fixed = await import(pathToFileURL(path.join(root, 'dist', 'src', 'fixed-tunnel.js')).href);
  const local = await import(pathToFileURL(path.join(root, 'dist', 'src', 'local-config.js')).href);
  fixed.assertFixedActivation(fixed.loadFixedConfig(runtime));
  local.loadLocalConfig(path.join(runtime, 'config.json'));
  const binary = path.join(root, '.tools', 'cloudflared-2026.8.2.exe');
  const entry = lstatSync(binary);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error();
  fixed.verifyFixedBinary(readFileSync(binary));
} catch { process.exitCode = 2; }
'@
  $TaskSavedPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $global:LASTEXITCODE = 1; $null = $TaskPreflight | & $TaskNode --input-type=module - $TaskRoot 2>&1; $TaskPreflightExit = $global:LASTEXITCODE }
  finally { $ErrorActionPreference = $TaskSavedPreference }
  if ($TaskPreflightExit -ne 0) {
    $TaskExit = $TaskPreflightExit
    throw '前置檢查未通過。請查看 docs/FIXED-ENTRY.md、autodev.ps1 doctor 與 fixed-tunnel.ps1 doctor；未啟動任何服務，勿刪除未完成狀態標記。'
  }

  Write-Output '啟動或確認既有 AutoDev core。'
  $TaskCore = Invoke-DailyScript (Join-Path $PSScriptRoot 'autodev.ps1') @('-Command', 'start')
  if ($TaskCore.Code -ne 0) { $TaskExit = $TaskCore.Code; throw 'AutoDev core 啟動失敗；請執行 .\scripts\autodev.ps1 doctor。固定入口尚未啟動。' }
  Write-Output '啟動或確認固定入口；路由建立可能需要數分鐘。'
  $TaskFixed = Invoke-DailyScript (Join-Path $PSScriptRoot 'fixed-tunnel.ps1') @('-Action', 'start')
  if ($TaskFixed.Code -ne 0) { $TaskExit = $TaskFixed.Code; throw '固定入口啟動失敗；請執行 .\scripts\fixed-tunnel.ps1 status 與 doctor。已運行的 core 保留。' }
  $TaskStatus = Invoke-DailyScript (Join-Path $PSScriptRoot 'fixed-tunnel.ps1') @('-Action', 'status')
  if ($TaskStatus.Code -ne 0) { $TaskExit = $TaskStatus.Code; throw '固定入口狀態檢查失敗；請執行 .\scripts\fixed-tunnel.ps1 doctor。既有程序保留。' }
  try { $TaskState = $TaskStatus.Text | ConvertFrom-Json -ErrorAction Stop }
  catch { throw '固定入口狀態回應無法核對；請執行 .\scripts\fixed-tunnel.ps1 doctor。既有程序保留。' }
  if (-not ($TaskState.ready_for_chatgpt_probe -is [bool]) -or $TaskState.ready_for_chatgpt_probe -ne $true) {
    throw '固定入口尚未就緒；請執行 .\scripts\fixed-tunnel.ps1 status 與 doctor。既有程序保留。'
  }
  Write-Output 'AutoDev core 與本次固定入口已就緒，可回到既有 ChatGPT App。'
  Write-Output '此檢查確認連線準備狀態；ChatGPT 實際工具驗收見 docs/FIXED-ENTRY-VALIDATION.md。'
  $TaskExit = 0
} catch {
  # Only our own fixed messages are shown; do not render child output or parser
  # diagnostics that could include private runtime contents.
  $TaskMessage = $_.Exception.Message
  if ($TaskMessage -notmatch '^(啟動腳本|此工作區|前置檢查|AutoDev core|固定入口)') { $TaskMessage = '日常啟動前置條件無法核對。請確認 Node.js 20+ 與完整既有產品安裝，查看 docs/FIXED-ENTRY.md。' }
  [Console]::Error.WriteLine("$TaskMessage (exit $TaskExit)")
} finally {
  if ($TaskOwnsMutex) { $TaskMutex.ReleaseMutex() }
  if ($null -ne $TaskMutex) { $TaskMutex.Dispose() }
}
exit $TaskExit
