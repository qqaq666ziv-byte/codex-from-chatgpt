import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const product = fileURLToPath(new URL("../", import.meta.url));
const testRoot = path.join(product, ".local-tests");
mkdirSync(testRoot, { recursive: true });
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = "synthetic-private-runtime-backup-token";
const readable = (value: string) => value.replace(/<[^>]+>/g, "").replace(/_x000D_|_x000A_/g, "");

async function command(shell: string, script: string, environment: NodeJS.ProcessEnv = process.env) {
  try {
    const result = await execute(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from("$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n" + script, "utf16le").toString("base64")], { cwd: product, windowsHide: true, timeout: 90_000, env: environment, maxBuffer: 1_000_000 });
    return { code: 0, stdout: result.stdout, output: result.stdout + readable(result.stderr) };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", output: (failure.stdout ?? "") + readable(failure.stderr ?? "") };
  }
}

async function fixture() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const root = mkdtempSync(path.join(testRoot, "backup 中文 space-"));
  const scripts = path.join(root, "scripts");
  const runtime = path.join(root, ".runtime");
  const binaries = path.join(root, "bin");
  for (const directory of [scripts, runtime, binaries]) mkdirSync(directory);
  for (const file of ["autodev.ps1", "local-common.ps1", "backup-common.ps1"]) copyFileSync(path.join(product, "scripts", file), path.join(scripts, file));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.4.0", type: "commonjs" }));
  writeFileSync(path.join(runtime, "config.json"), JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port, model: "fake-model", reasoningEffort: "xhigh", projects: [] }));
  writeFileSync(path.join(runtime, "jobs.json"), JSON.stringify({ version: 1, jobs: [] }));
  writeFileSync(path.join(runtime, "admin-token"), token);
  writeFileSync(path.join(runtime, "client-token"), "synthetic-client-runtime-backup-token");
  writeFileSync(path.join(runtime, "secure-tunnel.json"), JSON.stringify({ schemaVersion: 1, tunnelId: "synthetic-fixture-tunnel" }));
  writeFileSync(path.join(runtime, "secure-tunnel-key.dpapi"), "synthetic-ciphertext-fixture-not-a-real-key");
  writeFileSync(path.join(runtime, "secure-tunnel-client.yml"), "synthetic-generated-volatile-config");
  writeFileSync(path.join(runtime, "fixed-tunnel.json"), JSON.stringify({ schemaVersion: 1 }));
  writeFileSync(path.join(runtime, "fixed-oauth.dpapi"), "synthetic-encrypted-oauth-snapshot");
  writeFileSync(path.join(runtime, "fixed-tunnel-client.yml"), "synthetic-volatile-fixed-config");
  writeFileSync(path.join(runtime, "fixed-cloudflared.yml"), "synthetic-current-volatile-fixed-config");
  const state = { version: 1, records: [] };
  writeFileSync(path.join(runtime, "product-state.json"), JSON.stringify({ checksum: hash(JSON.stringify(state)), state }));
  writeFileSync(path.join(runtime, "requests.json"), JSON.stringify({ schemaVersion: 1, records: [], checksum: hash('{"records":[],"schemaVersion":1}') }));
  mkdirSync(path.join(runtime, "evidence", "fixture"), { recursive: true });
  writeFileSync(path.join(runtime, "evidence", "fixture", "artifact.txt"), "synthetic-evidence");
  writeFileSync(path.join(runtime, "server-fixture.stdout.log"), "synthetic-private-log");
  writeFileSync(path.join(runtime, "config.json.fixture.bak"), "synthetic-old-config");
  writeFileSync(path.join(runtime, "server-process.json"), JSON.stringify({ pid: 2147483647 }));
  writeFileSync(path.join(runtime, "gateway.json"), JSON.stringify({ pid: 2147483647 }));
  writeFileSync(path.join(runtime, "secure-tunnel-process.json"), JSON.stringify({ pid: 2147483647 }));
  writeFileSync(path.join(runtime, "fixed-gateway-process.json"), JSON.stringify({ pid: 2147483647 }));
  writeFileSync(path.join(binaries, "npm.cmd"), '@echo off\r\necho %*>>"%AUTODEV_TEST_NPM_LOG%"\r\nif "%AUTODEV_TEST_NPM_FAIL%"=="1" exit /b 7\r\nexit /b 0\r\n');
  writeFileSync(path.join(binaries, "codex.cmd"), "@exit /b 0\r\n");
  const npmLog = path.join(root, "npm-invocations.txt");
  const environment = { ...process.env, PATH: binaries + path.delimiter + process.env.PATH, AUTODEV_TEST_NPM_LOG: npmLog };
  return {
    root, runtime, npmLog, environment,
    run: (shell: string, action: string, id?: string, extra: NodeJS.ProcessEnv = {}) => command(shell, `& ${quote(path.join(scripts, "autodev.ps1"))} ${action}${id ? ` -BackupId ${quote(id)}` : ""}`, { ...environment, ...extra }),
  };
}

function backupId(output: string) {
  const id = output.match(/Verified private runtime backup: ([0-9]{8}T[0-9]{9}Z-[a-f0-9]{12})/)?.[1];
  assert.ok(id, output);
  return id;
}

for (const shell of ["powershell.exe", "pwsh.exe"]) {
  test(`${shell}: first setup creates private configuration and credentials after the stopped checks`, { skip: process.platform !== "win32", timeout: 90_000 }, async context => {
    if (shell === "pwsh.exe" && (await command(shell, "$PSVersionTable.PSVersion.ToString()")).code !== 0) { context.skip("PowerShell 7 is unavailable"); return; }
    const value = await fixture();
    const port = JSON.parse(readFileSync(path.join(value.runtime, "config.json"), "utf8")).port;
    for (const name of ["config.json", "jobs.json", "product-state.json", "requests.json", "admin-token", "client-token"]) unlinkSync(path.join(value.runtime, name));
    const result = await command(shell, `& ${quote(path.join(value.root, "scripts", "autodev.ps1"))} setup -Port ${port}`, value.environment);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /setup completed/);
    assert.equal(JSON.parse(readFileSync(path.join(value.runtime, "config.json"), "utf8")).port, port);
    const credential = readFileSync(path.join(value.runtime, "admin-token"), "utf8");
    assert.equal(Buffer.from(credential, "base64").length, 32);
    assert.equal(result.output.includes(credential), false);
    assert.equal(existsSync(path.join(value.runtime, "build-incomplete.json")), false);
    assert.equal(readFileSync(value.npmLog, "utf8").trim().split(/\r?\n/).join("|"), "ci --ignore-scripts --no-audit --no-fund|run build");
  });

  test(`${shell}: offline backups verify hashes and ACLs, omit volatile files and restore with the prior runtime preserved`, { skip: process.platform !== "win32", timeout: 180_000 }, async context => {
    if (shell === "pwsh.exe" && (await command(shell, "$PSVersionTable.PSVersion.ToString()")).code !== 0) { context.skip("PowerShell 7 is unavailable"); return; }
    const value = await fixture();
    const result = await value.run(shell, "backup");
    assert.equal(result.code, 0, result.output);
    assert.equal(result.output.includes(token), false);
    const id = backupId(result.output);
    const location = path.join(value.root, ".backups", id);
    const manifest = JSON.parse(readFileSync(path.join(location, "manifest.json"), "utf8"));
    assert.ok(manifest.files.some((file: { path: string }) => file.path === "secure-tunnel-key.dpapi"));
    assert.ok(manifest.files.some((file: { path: string }) => file.path === "fixed-oauth.dpapi"));
    assert.ok(manifest.files.some((file: { path: string }) => file.path === "evidence/fixture/artifact.txt"));
    assert.equal(manifest.files.some((file: { path: string }) => /gateway|process|\.log|\.bak|\.yml|lease/.test(file.path)), false);
    assert.equal(existsSync(path.join(location, "runtime", "fixed-cloudflared.yml")), false);
    const acl = await command(shell, `
. ${quote(path.join(value.root, "scripts", "local-common.ps1"))}
if ($PSVersionTable.PSEdition -eq 'Desktop') { Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop }
$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Items = @((Get-Item -LiteralPath ${quote(path.join(value.root, ".backups"))})) + @(Get-ChildItem -LiteralPath ${quote(location)} -Recurse -Force)
$Wrong = @($Items | Where-Object { $Acl = Get-Acl -LiteralPath $_.FullName; -not $Acl.AreAccessRulesProtected -or @($Acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid }).Count -gt 0 }).Count
[Console]::Write($Wrong)
`);
    assert.equal(acl.code, 0, acl.output);
    assert.equal(acl.stdout, "0");
    assert.equal((await value.run(shell, "verify-backup", id)).code, 0);

    writeFileSync(path.join(value.runtime, "admin-token"), "synthetic-new-current-token");
    const restored = await value.run(shell, "restore", id);
    assert.equal(restored.code, 0, restored.output);
    assert.equal(restored.output.includes(token), false);
    assert.equal(readFileSync(path.join(value.runtime, "admin-token"), "utf8"), token);
    assert.equal(existsSync(path.join(value.runtime, 'fixed-oauth.dpapi')), false, 'Restore must not revive revoked OAuth grants');
    assert.ok(readdirSync(value.runtime).some(file => /^fixed-oauth-restored-.*\.dpapi$/.test(file)));
    assert.equal(existsSync(path.join(value.runtime, "server-process.json")), false);
    assert.equal(existsSync(path.join(value.runtime, "fixed-cloudflared.yml")), false);
    assert.ok(existsSync(path.join(value.runtime, "build-incomplete.json")));
    assert.notEqual((await value.run(shell, "start")).code, 0);
    const preserved = restored.output.match(/Preserved prior runtime: ([0-9]{8}T[0-9]{9}Z-[a-f0-9]{12})/)?.[1];
    assert.ok(preserved, restored.output);
    assert.equal(readFileSync(path.join(value.root, ".backups", preserved, "previous-runtime", "admin-token"), "utf8"), "synthetic-new-current-token");
    assert.equal(readFileSync(path.join(value.root, ".backups", preserved, "previous-runtime", "server-fixture.stdout.log"), "utf8"), "synthetic-private-log");
    const preservedAcl = await command(shell, `
if ($PSVersionTable.PSEdition -eq 'Desktop') { Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop }
$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Wrong = @(Get-ChildItem -LiteralPath ${quote(path.join(value.root, ".backups", preserved, "previous-runtime"))} -Recurse -Force | Where-Object { $Acl = Get-Acl -LiteralPath $_.FullName; -not $Acl.AreAccessRulesProtected -or @($Acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid }).Count -gt 0 }).Count
[Console]::Write($Wrong)
`);
    assert.equal(preservedAcl.code, 0, preservedAcl.output);
    assert.equal(preservedAcl.stdout, "0");

    writeFileSync(path.join(location, "runtime", "admin-token"), "tampered");
    const rejected = await value.run(shell, "restore", id);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.output, /checksum mismatch/i);
    assert.equal(readFileSync(path.join(value.runtime, "admin-token"), "utf8"), token);
    assert.notEqual((await value.run(shell, "verify-backup", "../outside")).code, 0);
  });

  test(`${shell}: update backs up before a build failure; unsupported or active state prevents any build`, { skip: process.platform !== "win32", timeout: 180_000 }, async context => {
    if (shell === "pwsh.exe" && (await command(shell, "$PSVersionTable.PSVersion.ToString()")).code !== 0) { context.skip("PowerShell 7 is unavailable"); return; }
    const value = await fixture();
    const failed = await value.run(shell, "update", undefined, { AUTODEV_TEST_NPM_FAIL: "1" });
    assert.notEqual(failed.code, 0, failed.output);
    assert.match(failed.output, /failed \(exit 7\)/);
    assert.ok(existsSync(path.join(value.root, ".backups", backupId(failed.output), "manifest.json")));
    assert.equal(readFileSync(path.join(value.runtime, "admin-token"), "utf8"), token);
    assert.equal(readFileSync(value.npmLog, "utf8").trim(), "ci --ignore-scripts --no-audit --no-fund");
    assert.ok(existsSync(path.join(value.runtime, "build-incomplete.json")));
    const unsafeStart = await value.run(shell, "start");
    assert.notEqual(unsafeStart.code, 0);
    assert.match(unsafeStart.output, /incomplete/);
    const successful = await value.run(shell, "update");
    assert.equal(successful.code, 0, successful.output);
    assert.match(successful.output, /built and verified/);
    assert.equal(existsSync(path.join(value.runtime, "build-incomplete.json")), false);
    assert.equal(readFileSync(value.npmLog, "utf8").trim().split(/\r?\n/).join("|"), "ci --ignore-scripts --no-audit --no-fund|ci --ignore-scripts --no-audit --no-fund|run typecheck|test|run build");
    for (const fence of ['fixed-oauth.dpapi.pending', 'fixed-deploy-incomplete.json']) {
      const current = await fixture();
      writeFileSync(path.join(current.runtime, fence), '{"schemaVersion":1,"status":"incomplete"}');
      const rejected = await current.run(shell, 'backup');
      assert.notEqual(rejected.code, 0, rejected.output);
      assert.equal(existsSync(path.join(current.root, '.backups')), false);
      assert.equal(existsSync(path.join(current.runtime, fence)), true);
    }
    for (const jobs of [{ version: 99, jobs: [] }, { version: 1, jobs: [{ job_id: "synthetic", status: "running" }] }, { version: 1, jobs: [{ job_id: "synthetic", status: "recovery_required" }] }]) {
      const current = await fixture();
      writeFileSync(path.join(current.runtime, "jobs.json"), JSON.stringify(jobs));
      const rejected = await current.run(shell, "update");
      assert.notEqual(rejected.code, 0, rejected.output);
      assert.match(rejected.output, /unsupported schema|active|recovery-required/);
      assert.equal(existsSync(current.npmLog), false);
      assert.equal(existsSync(path.join(current.root, ".backups")), false);
    }
    const before = readFileSync(path.join(value.runtime, "jobs.json"), "utf8");
    writeFileSync(path.join(value.runtime, "jobs.json"), JSON.stringify({ version: 99, jobs: [] }));
    const restore = await value.run(shell, "restore", backupId(failed.output));
    assert.notEqual(restore.code, 0);
    assert.match(restore.output, /unsupported schema/);
    assert.notEqual(readFileSync(path.join(value.runtime, "jobs.json"), "utf8"), before);
  });

  test(`${shell}: live gateway records and writer leases block setup and update without stopping unrelated processes`, { skip: process.platform !== "win32", timeout: 180_000 }, async context => {
    if (shell === "pwsh.exe" && (await command(shell, "$PSVersionTable.PSVersion.ToString()")).code !== 0) { context.skip("PowerShell 7 is unavailable"); return; }
    const value = await fixture();
    for (const name of ["gateway.json", "secure-tunnel-process.json", "fixed-gateway-process.json"]) {
      writeFileSync(path.join(value.runtime, name), JSON.stringify({ pid: process.pid }));
      for (const action of ["setup", "update", "backup"]) {
        const rejected = await value.run(shell, action);
        assert.notEqual(rejected.code, 0, rejected.output);
        assert.match(rejected.output, /managed connection.*stopped/);
        assert.equal(existsSync(value.npmLog), false);
      }
      writeFileSync(path.join(value.runtime, name), JSON.stringify({ pid: 2147483647 }));
    }
    for (const subdirectory of ["", "gateway-lease", "secure-tunnel-lease", "fixed-gateway-lease"]) {
      const directory = path.join(value.runtime, subdirectory);
      mkdirSync(directory, { recursive: true });
      const result = await command(shell, `
. ${quote(path.join(value.root, "scripts", "local-common.ps1"))}
. ${quote(path.join(value.root, "scripts", "backup-common.ps1"))}
$Lease = Enter-AutoDevOfflineLease ${quote(directory)}
try {
  & ${quote(shell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(path.join(value.root, "scripts", "autodev.ps1"))} update
  if ($LASTEXITCODE -eq 0) { throw 'Concurrent writer was not rejected' }
} finally { $Lease.ReleaseMutex(); $Lease.Dispose() }
`, value.environment);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /live writer/);
      assert.equal(existsSync(value.npmLog), false);
    }
    assert.equal(readdirSync(value.root).includes(".backups"), false);
  });

  test(`${shell}: linked runtime trees and traversal or unlisted backup members are rejected`, { skip: process.platform !== "win32", timeout: 180_000 }, async context => {
    if (shell === "pwsh.exe" && (await command(shell, "$PSVersionTable.PSVersion.ToString()")).code !== 0) { context.skip("PowerShell 7 is unavailable"); return; }
    const value = await fixture();
    const saved = await value.run(shell, "backup");
    assert.equal(saved.code, 0, saved.output);
    const id = backupId(saved.output);
    const location = path.join(value.root, ".backups", id);
    const manifestFile = path.join(location, "manifest.json");
    const original = readFileSync(manifestFile, "utf8");
    const changed = JSON.parse(original);
    changed.files[0].path = "../../outside";
    writeFileSync(manifestFile, JSON.stringify(changed));
    const traversal = await value.run(shell, "verify-backup", id);
    assert.notEqual(traversal.code, 0);
    assert.match(traversal.output, /member path/);
    writeFileSync(manifestFile, original);
    writeFileSync(path.join(location, "runtime", "unlisted.txt"), "unlisted fixture");
    const unlisted = await value.run(shell, "verify-backup", id);
    assert.notEqual(unlisted.code, 0);
    assert.match(unlisted.output, /unlisted files/);
    const target = path.join(value.root, "junction-target");
    mkdirSync(target);
    const junction = await command(shell, `New-Item -ItemType Junction -Path ${quote(path.join(value.runtime, "linked-fixture"))} -Target ${quote(target)} | Out-Null`);
    assert.equal(junction.code, 0, junction.output);
    const rejected = await value.run(shell, "backup");
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.output, /linked files or directories/);
    assert.equal(existsSync(value.npmLog), false);
  });
}
