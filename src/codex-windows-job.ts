import path from 'node:path';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';

// Based on the existing Windows job owner. Atomic job assignment and explicit
// pipe inheritance preserve JSONL transport without exposing prompts in argv.
const CODEX_JOB_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
# AUTODEV_CODEX_JOB_OWNER
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class AutoDevCodexJob : IDisposable {
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
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public bool inherit; }
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint low, high; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FILETIME created, out FILETIME exited, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] static extern bool QueryMembers(IntPtr job, int infoClass, IntPtr info, uint size, IntPtr length);
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
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  IntPtr job = IntPtr.Zero;
  PROCESS_INFORMATION child;
  bool assigned;
  long rootCreated;
  IntPtr childInput, parentInput, parentOutput, childOutput, parentError, childError;
  static long Birth(IntPtr handle) {
    FILETIME created, exited, kernel, user;
    if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new InvalidOperationException();
    return ((long)created.high << 32) | created.low;
  }
  void Pipes() {
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES(); sa.length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.inherit = true;
    if (!CreatePipe(out childInput, out parentInput, ref sa, 0) ||
        !CreatePipe(out parentOutput, out childOutput, ref sa, 0) ||
        !CreatePipe(out parentError, out childError, ref sa, 0)) throw new InvalidOperationException();
    foreach (IntPtr handle in new[] {parentInput, parentOutput, parentError})
      if (!SetHandleInformation(handle, 1, 0)) throw new InvalidOperationException();
  }
  static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
  static FileStream Stream(ref IntPtr handle, FileAccess access) {
    var owned = new Microsoft.Win32.SafeHandles.SafeFileHandle(handle, true); handle = IntPtr.Zero;
    return new FileStream(owned, access);
  }
  void VerifyMembers() {
    // Job membership, held kernel handles and creation FILETIMEs bind inspection
    // to this launch. A reused PID outside this job is never targeted.
    if (child.hProcess != IntPtr.Zero && Birth(child.hProcess) != rootCreated) throw new InvalidOperationException();
    const int capacity = 4096;
    IntPtr list = Marshal.AllocHGlobal(8 + IntPtr.Size * capacity);
    try {
      if (!QueryMembers(job, 3, list, (uint)(8 + IntPtr.Size * capacity), IntPtr.Zero)) throw new InvalidOperationException();
      int count = Marshal.ReadInt32(list, 4);
      if (count < 0 || count > capacity) throw new InvalidOperationException();
      for (int i = 0; i < count; i++) {
        uint pid = unchecked((uint)Marshal.ReadIntPtr(list, 8 + IntPtr.Size * i).ToInt64());
        IntPtr handle = OpenProcess(0x00101000, false, pid);
        if (handle == IntPtr.Zero) {
          if (Marshal.GetLastWin32Error() == 87) continue; // exited between queries
          throw new InvalidOperationException();
        }
        try {
          bool member;
          if (!IsProcessInJob(handle, job, out member)) throw new InvalidOperationException();
          if (!member) continue;
          long created = Birth(handle);
          if (created < rootCreated || Birth(handle) != created) throw new InvalidOperationException();
        } finally { CloseHandle(handle); }
      }
    } finally { Marshal.FreeHGlobal(list); }
  }

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
  void Start(string executable, string[] args, string cwd, string[] names, string[] values, bool verbatim) {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new InvalidOperationException();
    EXTENDED_LIMIT limits = new EXTENDED_LIMIT();
    limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) throw new InvalidOperationException();
    Pipes();
    StringBuilder command = new StringBuilder(Quote(executable));
    foreach (string arg in args) { command.Append(' '); command.Append(verbatim ? arg : Quote(arg)); }
    StringBuilder environment = new StringBuilder();
    for (int i = 0; i < names.Length; i++) { environment.Append(names[i]); environment.Append('='); environment.Append(values[i]); environment.Append('\0'); }
    environment.Append('\0');
    if (names.Length == 0) environment.Append('\0');
    IntPtr block = Marshal.StringToHGlobalUni(environment.ToString());
    IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero, handles = IntPtr.Zero;
    bool attributesInitialized = false;
    try {
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      if (size == IntPtr.Zero) throw new InvalidOperationException();
      attributes = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw new InvalidOperationException();
      attributesInitialized = true;
      jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST makes creation and assignment atomic.
      // Even helper termination inside CreateProcess cannot orphan a child.
      // Unsupported systems fail closed, without a post-creation fallback.
      if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000d), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException();
      handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handles, 0, childInput); Marshal.WriteIntPtr(handles, IntPtr.Size, childOutput); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, childError);
      if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException();
      STARTUPINFOEX startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.AttributeList = attributes;
      startup.StartupInfo.dwFlags = 0x00000100;
      startup.StartupInfo.hStdInput = childInput; startup.StartupInfo.hStdOutput = childOutput; startup.StartupInfo.hStdError = childError;
      // Inherit only the three child pipe ends; never the sole job handle or
      // parent stdin. Parent/helper death therefore cannot orphan descendants.
      if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
          0x00000004 | 0x00000400 | 0x00080000 | 0x08000000, block, cwd, ref startup, out child)) throw new InvalidOperationException();
      assigned = true; rootCreated = Birth(child.hProcess);
    } finally {
      if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      for (int i = 0; i < environment.Length; i++) Marshal.WriteInt16(block, i * 2, 0);
      Marshal.FreeHGlobal(block);
    }
    Close(ref childInput); Close(ref childOutput); Close(ref childError);
    bool inJob;
    if (!IsProcessInJob(child.hProcess, job, out inJob) || !inJob) throw new InvalidOperationException();
    if (ResumeThread(child.hThread) == 0xffffffff) throw new InvalidOperationException();
    CloseHandle(child.hThread); child.hThread = IntPtr.Zero;
  }
  bool Stop() {
    bool ok = true;
    if (assigned) {
      try { VerifyMembers(); } catch { ok = false; }
      // This unnamed kernel job can contain only descendants of this launch.
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
    Close(ref childInput); Close(ref parentInput); Close(ref parentOutput); Close(ref childOutput); Close(ref parentError); Close(ref childError);
    // Closing the only job handle is the OS-enforced final safety net.
    if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    if (child.hThread != IntPtr.Zero) { CloseHandle(child.hThread); child.hThread = IntPtr.Zero; }
    if (child.hProcess != IntPtr.Zero) { CloseHandle(child.hProcess); child.hProcess = IntPtr.Zero; }
  }
  public static int Run(string executable, string[] args, string cwd, string[] names, string[] values, bool verbatim, int graceMs) {
    AutoDevCodexJob owner = new AutoDevCodexJob();
    int result = 0;
    System.Threading.Tasks.Task output = null, errors = null;
    try {
      owner.Start(executable, args, cwd, names, values, verbatim);
      var inputStream = Stream(ref owner.parentInput, FileAccess.Write);
      var outputStream = Stream(ref owner.parentOutput, FileAccess.Read);
      var errorStream = Stream(ref owner.parentError, FileAccess.Read);
      Console.Out.WriteLine("AUTODEV_CODEX_READY"); Console.Out.Flush();
      output = System.Threading.Tasks.Task.Factory.StartNew(() => { using (outputStream) outputStream.CopyTo(Console.OpenStandardOutput()); }, System.Threading.Tasks.TaskCreationOptions.LongRunning);
      errors = System.Threading.Tasks.Task.Factory.StartNew(() => { using (errorStream) errorStream.CopyTo(Console.OpenStandardError()); }, System.Threading.Tasks.TaskCreationOptions.LongRunning);
      var inputClosed = new ManualResetEvent(false);
      var input = System.Threading.Tasks.Task.Factory.StartNew(() => {
        try {
          using (var writer = new StreamWriter(inputStream, new UTF8Encoding(false))) {
            string line; while ((line = Console.In.ReadLine()) != null) { writer.WriteLine(line); writer.Flush(); }
          }
        } finally { inputClosed.Set(); }
      }, System.Threading.Tasks.TaskCreationOptions.LongRunning);
      uint ended = WaitForMultipleObjects(2, new[] {owner.child.hProcess, inputClosed.SafeWaitHandle.DangerousGetHandle()}, false, 0xffffffff);
      if (ended > 1) throw new InvalidOperationException();
      // EOF is graceful first. An early wrapper exit still drains/kills every
      // member, including children that retained stdout or detached from cmd.
      if (ended == 1) { WaitForSingleObject(owner.child.hProcess, (uint)graceMs); inputClosed.Dispose(); }
    } catch { result = 71; }
    finally {
      try { if (!owner.Stop()) result = 74; } catch { result = 74; }
      owner.Dispose();
      try {
        if (output != null && !output.Wait(5000)) result = 74;
        if (errors != null && !errors.Wait(5000)) result = 74;
      } catch { result = 74; }
    }
    return result;
  }
}
'@
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $Line = [Console]::In.ReadLine()
  if ($null -eq $Line) { exit 71 }
  # ASCII framing avoids the caller's Windows console code page corrupting
  # Chinese paths or environment values. This is pipe data, not an argv secret.
  $Payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Line)) | ConvertFrom-Json
  $Names = @($Payload.env.PSObject.Properties.Name | Sort-Object)
  $Values = @($Names | ForEach-Object { [string]$Payload.env.$_ })
  $Code = [AutoDevCodexJob]::Run([string]$Payload.executable, [string[]]@($Payload.args), [string]$Payload.cwd, [string[]]$Names, [string[]]$Values, [bool]$Payload.verbatim, [int]$Payload.graceMs)
  if ($Code -ne 0) { [Console]::Error.WriteLine('JOB_ERROR') }
  exit $Code
} catch { [Console]::Error.WriteLine('JOB_ERROR'); exit 71 }
`;

export function codexWindowsJob(command: string, args: string[], options: SpawnOptions, graceMs: number) {
  const environment: Record<string,string> = {};
  const names = new Set<string>();
  for (const [name,value] of Object.entries(options.env ?? process.env)) {
    if (value === undefined) continue;
    if (!name || /[=\0]/.test(name) || value.includes('\0') || names.has(name.toLowerCase())) throw new Error('Invalid Codex child environment.');
    names.add(name.toLowerCase()); environment[name]=value;
  }
  const cwd=String(options.cwd ?? process.cwd());
  if (!path.isAbsolute(command) || !path.isAbsolute(cwd) || [command,cwd,...args].some(v=>v.includes('\0'))) throw new Error('Invalid owned Codex launch.');
  if (options.shell || options.detached) throw new Error('Owned Codex launch does not support an extra shell or detached root.');
  const payload=Buffer.from(JSON.stringify({executable:command,args,cwd,env:environment,verbatim:options.windowsVerbatimArguments===true,graceMs}),'utf8').toString('base64');
  if (payload.length>2_000_000) throw new Error('Owned Codex launch configuration is too large.');
  const helperEnv:NodeJS.ProcessEnv={};
  for(const name of ['SystemRoot','WINDIR','TEMP','TMP','COMSPEC'])if(process.env[name])helperEnv[name]=process.env[name];
  return {command:path.join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    args:['-NoProfile','-NonInteractive','-Command',CODEX_JOB_HELPER],
    options:{cwd,env:helperEnv,windowsHide:true,stdio:['pipe','pipe','pipe']} satisfies SpawnOptions,
    prepare(child:ChildProcessWithoutNullStreams):Promise<void>{
      return new Promise((resolve,reject)=>{
        let buffer='',settled=false;
        const timer=setTimeout(()=>finish(new Error('Owned Codex job did not become ready.')),20000);
        function finish(error?:Error){
          if(settled)return;settled=true;clearTimeout(timer);
          child.stdout.off('data',data);child.off('error',failed);child.off('close',ended);
          if(error)reject(error);else resolve();
        }
        function data(chunk:Buffer|string){
          buffer+=chunk.toString(); const end=buffer.indexOf('\n');
          if(end<0){if(buffer.length>128)finish(new Error('Invalid owned Codex job handshake.'));return;}
          if(buffer.slice(0,end).trim()!=='AUTODEV_CODEX_READY'){finish(new Error('Invalid owned Codex job handshake.'));return;}
          child.stdout.pause();const tail=buffer.slice(end+1);if(tail)child.stdout.unshift(Buffer.from(tail,'utf8'));finish();
        }
        function failed(){finish(new Error('Owned Codex helper could not start.'));}
        function ended(){finish(new Error('Owned Codex job exited before readiness.'));}
        child.stdout.on('data',data);child.once('error',failed);child.once('close',ended);
        child.stdin.write(payload+'\n',error=>{if(error)failed();});
      });
    }};
}
