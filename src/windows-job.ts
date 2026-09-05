import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

export type WindowsJob = {
  /** The hidden job-owner helper. Its death closes the job and kills its children. */
  process: ChildProcessWithoutNullStreams;
  childPid: number;
  close(): Promise<void>;
};

// Fixed code only: neither the executable arguments nor the child environment
// appear in PowerShell argv, generated C# source, or a persistent profile/file.
// Windows 10+ assigns the child to its job atomically during CREATE_SUSPENDED;
// the native client cannot poll before job membership is verified and resumed.
const JOB_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
# AUTODEV_WINDOWS_JOB_OWNER
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class AutoDevWindowsJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public uint dwProcessId, dwThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr AttributeList;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ACCOUNTING info, uint size, IntPtr length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  IntPtr job = IntPtr.Zero;
  PROCESS_INFORMATION child;
  bool assigned;

  static string Quote(string value) {
    StringBuilder result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
      else { result.Append('\\', slashes); result.Append(c); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"');
    return result.ToString();
  }
  void Start(string executable, string[] args, string cwd, string[] names, string[] values) {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new InvalidOperationException();
    EXTENDED_LIMIT limits = new EXTENDED_LIMIT();
    limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) throw new InvalidOperationException();
    StringBuilder command = new StringBuilder(Quote(executable));
    foreach (string arg in args) { command.Append(' '); command.Append(Quote(arg)); }
    StringBuilder environment = new StringBuilder();
    for (int i = 0; i < names.Length; i++) { environment.Append(names[i]); environment.Append('='); environment.Append(values[i]); environment.Append('\0'); }
    environment.Append('\0');
    if (names.Length == 0) environment.Append('\0');
    IntPtr block = Marshal.StringToHGlobalUni(environment.ToString());
    IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero;
    bool attributesInitialized = false;
    try {
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      if (size == IntPtr.Zero) throw new InvalidOperationException();
      attributes = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new InvalidOperationException();
      attributesInitialized = true;
      jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST makes creation and assignment atomic.
      // Even helper termination inside CreateProcess cannot orphan a child.
      // Unsupported systems fail closed, without a post-creation fallback.
      if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000d), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException();
      STARTUPINFOEX startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.AttributeList = attributes;
      // No inherited handles: the native child cannot retain the helper stdin
      // pipe or the sole job handle and prevent parent-death cleanup.
      if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false,
          0x00000004 | 0x00000400 | 0x00080000 | 0x08000000, block, cwd, ref startup, out child)) throw new InvalidOperationException();
      assigned = true;
    } finally {
      if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      for (int i = 0; i < environment.Length; i++) Marshal.WriteInt16(block, i * 2, 0);
      Marshal.FreeHGlobal(block);
    }
    bool inJob;
    if (!IsProcessInJob(child.hProcess, job, out inJob) || !inJob) throw new InvalidOperationException();
    if (ResumeThread(child.hThread) == 0xffffffff) throw new InvalidOperationException();
    CloseHandle(child.hThread); child.hThread = IntPtr.Zero;
  }
  bool Stop() {
    bool ok = true;
    if (assigned) {
      if (!TerminateJobObject(job, 0)) ok = false;
    } else if (child.hProcess != IntPtr.Zero) {
      // Assignment failed while suspended: do not leave a runnable child.
      if (!TerminateProcess(child.hProcess, 71)) ok = false;
    }
    if (child.hProcess != IntPtr.Zero && WaitForSingleObject(child.hProcess, 10000) != 0) ok = false;
    if (assigned) {
      DateTime deadline = DateTime.UtcNow.AddSeconds(5);
      while (true) {
        ACCOUNTING info;
        if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero)) { ok = false; break; }
        if (info.ActiveProcesses == 0) break;
        if (DateTime.UtcNow >= deadline) { ok = false; break; }
        Thread.Sleep(20);
      }
    }
    return ok;
  }
  public void Dispose() {
    // Closing the only job handle is the OS-enforced final safety net.
    if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    if (child.hThread != IntPtr.Zero) { CloseHandle(child.hThread); child.hThread = IntPtr.Zero; }
    if (child.hProcess != IntPtr.Zero) { CloseHandle(child.hProcess); child.hProcess = IntPtr.Zero; }
  }
  public static int Run(string executable, string[] args, string cwd, string[] names, string[] values) {
    AutoDevWindowsJob owner = new AutoDevWindowsJob();
    int result = 0;
    try {
      owner.Start(executable, args, cwd, names, values);
      Console.Out.WriteLine("READY " + owner.child.dwProcessId); Console.Out.Flush();
      // Framework Console.In may implement ReadLineAsync synchronously. Keep
      // stdin on a worker so an independently exiting child is still observed.
      var input = System.Threading.Tasks.Task.Factory.StartNew(() => Console.In.ReadLine());
      while (!input.IsCompleted) {
        if (WaitForSingleObject(owner.child.hProcess, 100) == 0) { result = 72; break; }
      }
      if (input.IsCompleted) {
        string line = input.GetAwaiter().GetResult();
        if (line != null && line != "RELEASE") result = 73;
      }
    } catch { result = 71; }
    finally {
      if (!owner.Stop()) result = 74;
      owner.Dispose();
    }
    return result;
  }
}
'@
  $Line = [Console]::In.ReadLine()
  if ($null -eq $Line) { exit 71 }
  # ASCII framing avoids the caller's Windows console code page corrupting
  # Chinese paths or environment values. This is pipe data, not an argv secret.
  $Payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Line)) | ConvertFrom-Json
  $Names = @($Payload.env.PSObject.Properties.Name | Sort-Object)
  $Values = @($Names | ForEach-Object { [string]$Payload.env.$_ })
  $Code = [AutoDevWindowsJob]::Run([string]$Payload.executable, [string[]]@($Payload.args), [string]$Payload.cwd, [string[]]$Names, [string[]]$Values)
  if ($Code -ne 0) { [Console]::Error.WriteLine('JOB_ERROR') }
  exit $Code
} catch { [Console]::Error.WriteLine('JOB_ERROR'); exit 71 }
`;

export async function startWindowsJob(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<WindowsJob> {
  if (process.platform !== 'win32') throw new Error('Owned Windows jobs require Windows.');
  if (!path.isAbsolute(executable) || !path.isAbsolute(options.cwd) || [executable, options.cwd, ...args].some(value => value.includes('\0'))) throw new Error('Invalid Windows job launch arguments.');
  const env: Record<string, string> = {};
  const names = new Set<string>();
  for (const [name, value] of Object.entries(options.env)) {
    if (value === undefined) continue;
    if (!name || /[=\0]/.test(name) || value.includes('\0') || names.has(name.toLowerCase())) throw new Error('Invalid Windows job environment.');
    names.add(name.toLowerCase()); env[name] = value;
  }
  const payload = JSON.stringify({ executable, args, cwd: options.cwd, env });
  if (Buffer.byteLength(payload) > 1_048_576) throw new Error('Windows job launch configuration is too large.');
  const helperEnvironment: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']) if (process.env[name]) helperEnvironment[name] = process.env[name];
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', JOB_HELPER], {
    cwd: options.cwd, env: helperEnvironment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exited = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    helper.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
    helper.once('error', () => { if (!helper.pid) { exited = true; resolve({ code: null, signal: null }); } });
  });
  helper.stderr.on('data', () => { /* Only a fixed failure is exposed to callers. */ });
  helper.stdin.on('error', () => { /* Readiness/exit/close paths report fixed failures. */ });
  const waitForExit = (milliseconds: number) => new Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined>(resolve => {
    const timer = setTimeout(() => resolve(undefined), milliseconds); timer.unref();
    void exit.then(result => { clearTimeout(timer); resolve(result); });
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    if (!exited) helper.stdin.end('RELEASE\n');
    const result = await waitForExit(20000);
    if (!result) {
      if (!exited) helper.kill('SIGKILL'); // Exact helper handle, never a PID lookup.
      await waitForExit(5000);
      throw new Error('Windows job shutdown timed out; success was not confirmed.');
    }
    if (result.code !== 0 || result.signal !== null) throw new Error('Windows job owner exited unexpectedly; clean shutdown was not confirmed.');
  })();
  try {
    const childPid = await new Promise<number>((resolve, reject) => {
      let buffer = '', settled = false;
      const timer = setTimeout(() => finish(new Error('Windows job did not become ready.')), 20000);
      function finish(error?: Error, pid?: number) {
        if (settled) return; settled = true; clearTimeout(timer);
        helper.stdout.off('data', data); helper.off('error', failed); helper.off('exit', ended);
        if (error) reject(error); else resolve(pid!);
      }
      function data(chunk: Buffer) {
        buffer += chunk.toString('ascii');
        if (buffer.length > 128) { finish(new Error('Invalid Windows job readiness response.')); return; }
        const match = /^READY ([1-9][0-9]*)\r?\n$/.exec(buffer);
        if (match) {
          const pid = Number(match[1]);
          if (!Number.isSafeInteger(pid)) finish(new Error('Invalid Windows job child identity.'));
          else finish(undefined, pid);
        } else if (buffer.includes('\n')) finish(new Error('Invalid Windows job readiness response.'));
      }
      function failed() { finish(new Error('Windows job helper could not start.')); }
      function ended() { finish(new Error('Windows job failed before starting its child.')); }
      helper.stdout.on('data', data); helper.once('error', failed); helper.once('exit', ended);
      helper.stdin.write(Buffer.from(payload, 'utf8').toString('base64') + '\n', error => { if (error) failed(); });
    });
    helper.stdout.resume();
    return { process: helper, childPid, close };
  } catch (error) {
    try { await close(); } catch { /* Preserve the fixed startup error. */ }
    throw error;
  }
}
