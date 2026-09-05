import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const product = fileURLToPath(new URL("../", import.meta.url));
const testRoot = path.join(product, ".local-tests");
mkdirSync(testRoot, { recursive: true });
const fakeToken = "synthetic-admin-credential-for-fixture-only";
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

async function powershell(shell: string, args: string[]) {
  try {
    // This applies only to the test child process. Never change a user or
    // machine execution policy, and never override a Group Policy failure.
    const result = await execute(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], { cwd: product, windowsHide: true, timeout: 60_000, maxBuffer: 2_000_000 });
    return { code: 0, stdout: result.stdout, output: result.stdout + result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", output: (failure.stdout ?? "") + (failure.stderr ?? "") };
  }
}

async function command(shell: string, script: string) {
  return powershell(shell, ["-EncodedCommand", Buffer.from("$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n" + script, "utf16le").toString("base64")]);
}

async function unusedPort() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function fixture(port: number, options: { wrongIdentity?: boolean; exitEarly?: boolean } = {}) {
  const root = mkdtempSync(path.join(testRoot, "windows 中文 space-"));
  const scripts = path.join(root, "scripts");
  const runtime = path.join(root, ".runtime");
  mkdirSync(scripts);
  mkdirSync(runtime);
  mkdirSync(path.join(root, "dist", "src"), { recursive: true });
  for (const file of ["autodev.ps1", "local-common.ps1"]) copyFileSync(path.join(product, "scripts", file), path.join(scripts, file));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "commonjs" }));
  writeFileSync(path.join(runtime, "config.json"), JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port, model: "fake-model", reasoningEffort: "high", projects: [], ...options }));
  writeFileSync(path.join(runtime, "admin-token"), fakeToken);
  writeFileSync(path.join(runtime, "client-token"), "synthetic-client-fixture-token");
  writeFileSync(path.join(root, "dist", "src", "index.js"), `
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const config = JSON.parse(fs.readFileSync(process.env.AUTODEV_CONFIG, 'utf8'));
const runtime = path.dirname(process.env.AUTODEV_CONFIG);
const token = fs.readFileSync(path.join(runtime, 'admin-token'), 'utf8');
const instance = process.argv.find(value => value.startsWith('--autodev-instance='))?.split('=')[1];
if (config.exitEarly) process.exit(7);
const server = http.createServer((req, res) => {
  if (req.url !== '/readyz' && req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end('{}'); return; }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/admin/shutdown') { res.end('{}'); server.close(() => process.exit(0)); return; }
    if (req.url === '/admin/status') { res.end(JSON.stringify({ ready: true, process_id: process.pid + (config.wrongIdentity ? 1 : 0), instance_id: instance, jobs: [] })); return; }
    if (req.url === '/admin/approval' || req.url === '/admin/answer') {
      const message = { url: req.url, body: JSON.parse(body) };
      fs.writeFileSync(path.join(runtime, 'received.json'), JSON.stringify(message));
      res.end(JSON.stringify({ recorded: true })); return;
    }
    res.end(JSON.stringify({ ready: true }));
  });
});
server.listen(config.port, '127.0.0.1');
`);
  return {
    root, runtime, record: path.join(runtime, "server-process.json"),
    run: (shell: string, ...args: string[]) => powershell(shell, ["-File", path.join(scripts, "autodev.ps1"), ...args]),
  };
}

for (const shell of ["powershell.exe", "pwsh.exe"]) {
  test(`${shell}: runtime ACL, random token generation and native argument roundtrip`, { skip: process.platform !== "win32" }, async context => {
    const available = await command(shell, "$PSVersionTable.PSVersion.ToString()");
    if (shell === "pwsh.exe" && available.code !== 0) { context.skip("PowerShell 7 is not available"); return; }
    assert.equal(available.code, 0, available.output);
    const value = fixture(await unusedPort());
    const argsFile = path.join(value.root, "argv.json");
    const argvScript = path.join(value.root, "argv.cjs");
    writeFileSync(argvScript, "require('node:fs').writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)))");
    const args = ["中文 with spaces", 'literal "quoted" value', "trailing space\\", ""];
    const result = await command(shell, `
$ErrorActionPreference = 'Stop'
. ${quote(path.join(value.root, "scripts", "local-common.ps1"))}
Protect-AutoDevRuntime ${quote(value.runtime)}
Protect-AutoDevRuntime ${quote(value.runtime)}
$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$DirectoryAcl = Get-Acl -LiteralPath ${quote(value.runtime)}
$FileAcl = Get-Acl -LiteralPath ${quote(path.join(value.runtime, "admin-token"))}
$DirectoryOnly = @($DirectoryAcl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid }).Count -eq 0
$FileOnly = @($FileAcl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $CurrentSid }).Count -eq 0
$TokenOne = New-AutoDevToken
$TokenTwo = New-AutoDevToken
$Arguments = (@(${[argvScript, argsFile, ...args].map(quote).join(", ")}) | ForEach-Object { ConvertTo-AutoDevNativeArgument $_ }) -join ' '
$Child = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList $Arguments -WindowStyle Hidden -Wait -PassThru
Assert-AutoDevExit 'Native arguments roundtrip' $Child.ExitCode
@{ directoryProtected = $DirectoryAcl.AreAccessRulesProtected; fileProtected = $FileAcl.AreAccessRulesProtected; directoryOnlyCurrentSid = $DirectoryOnly; fileOnlyCurrentSid = $FileOnly; tokenBytes = [Convert]::FromBase64String($TokenOne).Length; distinctTokens = ($TokenOne -ne $TokenTwo) } | ConvertTo-Json -Compress
`);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(JSON.parse(result.stdout), { directoryProtected: true, fileProtected: true, directoryOnlyCurrentSid: true, fileOnlyCurrentSid: true, tokenBytes: 32, distinctTokens: true });
    assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")), args);
  });

  test(`${shell}: owned lifecycle, approval ID types and no secret output`, { skip: process.platform !== "win32", timeout: 180_000 }, async context => {
    if (shell === "pwsh.exe" && (await command(shell, "$PSVersionTable.PSVersion.ToString()")).code !== 0) { context.skip("PowerShell 7 is not available"); return; }
    const value = fixture(await unusedPort());
    // Simulate a pre-reboot record whose old process no longer exists. The
    // script may replace this record but must never guess that a reused PID is
    // still its process (the changed creation time case below checks that).
    writeFileSync(value.record, JSON.stringify({ schemaVersion: 1, pid: 2147483647, created_utc: "2000-01-01T00:00:00.000Z", root: value.root }));
    let originalRecord: string | undefined;
    try {
      const start = await value.run(shell, "start");
      assert.equal(start.code, 0, start.output);
      assert.match(start.output, /AutoDev ready/);
      assert.equal(start.output.includes(fakeToken), false);
      originalRecord = readFileSync(value.record, "utf8");
      const record = JSON.parse(originalRecord);
      const secondStart = await value.run(shell, "start");
      assert.equal(secondStart.code, 0, secondStart.output);
      assert.match(secondStart.output, /already running/);
      assert.equal(readFileSync(value.record, "utf8"), originalRecord);
      const status = await value.run(shell, "status");
      assert.equal(status.code, 0, status.output);
      assert.equal(JSON.parse(status.stdout).process_id, record.pid);
      assert.equal(JSON.parse(status.stdout).instance_id, record.instanceId);

      for (const [type, expected] of [["string", "42"], ["number", 42]] as const) {
        const result = await value.run(shell, "approve", "-JobId", "job-fixture", "-TurnId", "turn-fixture", "-RequestId", "42", "-RequestIdType", type, "-Decision", "decline");
        assert.equal(result.code, 0, result.output);
        assert.equal(result.output.includes(fakeToken), false);
        const received = JSON.parse(readFileSync(path.join(value.runtime, "received.json"), "utf8"));
        assert.equal(received.body.request_id, expected);
        assert.equal(received.body.job_id, "job-fixture");
        assert.equal(received.body.turn_id, "turn-fixture");
      }
      const invalidId = await value.run(shell, "approve", "-JobId", "job-fixture", "-TurnId", "turn-fixture", "-RequestId", "9007199254740992", "-RequestIdType", "number", "-Decision", "decline");
      assert.notEqual(invalidId.code, 0);
      assert.match(invalidId.output, /safe integer/);
      const answersFile = path.join(value.root, "answers.json");
      writeFileSync(answersFile, JSON.stringify({ color: { answers: ["藍色"] } }));
      const answer = await value.run(shell, "answer", "-JobId", "job-fixture", "-TurnId", "turn-fixture", "-RequestId", "q1", "-AnswersFile", answersFile);
      assert.equal(answer.code, 0, answer.output);
      assert.deepEqual(JSON.parse(readFileSync(path.join(value.runtime, "received.json"), "utf8")).body.answers, { color: { answers: ["藍色"] } });

      const setup = await value.run(shell, "setup");
      assert.notEqual(setup.code, 0, setup.output);
      assert.match(setup.output, /running|live|stop/i);
      const update = await value.run(shell, "update");
      assert.notEqual(update.code, 0, update.output);
      assert.match(update.output, /running|live|stop/i);
      assert.equal(JSON.parse((await value.run(shell, "status")).stdout).process_id, record.pid);

      writeFileSync(value.record, JSON.stringify({ ...record, created_utc: "2000-01-01T00:00:00.000Z" }));
      const rejected = await value.run(shell, "stop");
      assert.notEqual(rejected.code, 0, rejected.output);
      assert.match(rejected.output, /Refusing|mismatch/);
      assert.ok(existsSync(value.record));
      writeFileSync(value.record, originalRecord);
      assert.equal(JSON.parse((await value.run(shell, "status")).stdout).process_id, record.pid);
      const stopped = await value.run(shell, "stop");
      assert.equal(stopped.code, 0, stopped.output);
      assert.equal(existsSync(value.record), false);
      originalRecord = undefined;
      assert.match((await value.run(shell, "status")).output, /stopped/);
    } finally {
      // Restore only the record created by this fixture so cleanup must verify
      // the same PID, creation time, binary, workspace and instance marker.
      if (originalRecord) { writeFileSync(value.record, originalRecord); await value.run(shell, "stop"); }
    }
  });

  test(`${shell}: project registration atomically preserves canonical paths and rejects duplicates and private runtime`, { skip: process.platform !== "win32" }, async context => {
    if (shell === "pwsh.exe" && (await command(shell, "$PSVersionTable.PSVersion.ToString()")).code !== 0) { context.skip("PowerShell 7 is not available"); return; }
    const value = fixture(await unusedPort());
    const projectPath = path.join(value.root, "sample project");
    mkdirSync(projectPath);
    const addProject = await value.run(shell, "add-project", "-ProjectId", "sample", "-ProjectPath", projectPath);
    assert.equal(addProject.code, 0, addProject.output);
    const configFile = path.join(value.runtime, "config.json");
    const savedConfig = readFileSync(configFile, "utf8");
    assert.equal(JSON.parse(savedConfig).projects[0].path.toLowerCase(), projectPath.toLowerCase());
    const duplicate = await value.run(shell, "add-project", "-ProjectId", "sample", "-ProjectPath", projectPath);
    assert.notEqual(duplicate.code, 0, duplicate.output);
    assert.equal(readFileSync(configFile, "utf8"), savedConfig);
    const privateProject = await value.run(shell, "add-project", "-ProjectId", "private", "-ProjectPath", value.runtime);
    assert.notEqual(privateProject.code, 0, privateProject.output);
    assert.equal(readFileSync(configFile, "utf8"), savedConfig);
  });

  test(`${shell}: occupied ports preserve unrelated listeners; failed readiness is not success`, { skip: process.platform !== "win32", timeout: 120_000 }, async context => {
    if (shell === "pwsh.exe" && (await command(shell, "$PSVersionTable.PSVersion.ToString()")).code !== 0) { context.skip("PowerShell 7 is not available"); return; }
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    try {
      const address = listener.address();
      assert.ok(address && typeof address === "object");
      const occupied = fixture(address.port);
      const result = await occupied.run(shell, "start");
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /occupied/);
      assert.ok(listener.listening);
      assert.equal(existsSync(occupied.record), false);
    } finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }

    for (const options of [{ wrongIdentity: true }, { exitEarly: true }]) {
      const value = fixture(await unusedPort(), options);
      try {
        const result = await value.run(shell, "start");
        assert.notEqual(result.code, 0, result.output);
        assert.doesNotMatch(result.output, /AutoDev ready/);
        assert.equal(result.output.includes(fakeToken), false);
        assert.equal(existsSync(value.record), false, result.output);
      } finally { if (existsSync(value.record)) await value.run(shell, "stop"); }
    }
  });
}
