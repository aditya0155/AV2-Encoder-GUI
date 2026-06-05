param (
    [int]$targetPid
)

$code = @"
using System;
using System.Runtime.InteropServices;

public class ProcessThrottling {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetProcessInformation(IntPtr hProcess, int ProcessClass, ref PROCESS_POWER_THROTTLING_STATE pProcessInformation, uint cbProcessInformationLength);

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_POWER_THROTTLING_STATE {
        public uint Version;
        public uint ControlMask;
        public uint StateMask;
    }

    public static bool DisableEcoQoS(int pid) {
        IntPtr hProcess = OpenProcess(0x0200, false, pid); // PROCESS_SET_INFORMATION
        if (hProcess == IntPtr.Zero) return false;

        PROCESS_POWER_THROTTLING_STATE state = new PROCESS_POWER_THROTTLING_STATE();
        state.Version = 1; // PROCESS_POWER_THROTTLING_CURRENT_VERSION
        state.ControlMask = 0x1; // PROCESS_POWER_THROTTLING_EXECUTION_SPEED
        state.StateMask = 0;     // Disable the throttling state

        bool result = SetProcessInformation(hProcess, 4, ref state, (uint)Marshal.SizeOf(state)); // 4 = ProcessPowerThrottling
        CloseHandle(hProcess);
        return result;
    }

    [DllImport("kernel32.dll")]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);
}
"@

Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
[ProcessThrottling]::DisableEcoQoS($targetPid)
