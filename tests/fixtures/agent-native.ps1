param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('create', 'probe', 'metrics', 'edit', 'replace', 'truncate')]
    [string] $Mode,
    [string] $Manifest,
    [string] $Target,
    [int] $AgentProcessId
)

$ErrorActionPreference = 'Stop'
$length = 1073741824L

function New-SparseFixture([string] $Path, [int] $Modulo = 251) {
    if (-not ('AgentNativeSparse' -as [type])) {
        Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AgentNativeSparse {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DeviceIoControl(SafeFileHandle file, uint code,
        IntPtr input, uint inputSize, IntPtr output, uint outputSize,
        out uint returned, IntPtr overlapped);
}
'@
    }
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try {
        [uint32] $returned = 0
        if (-not [AgentNativeSparse]::DeviceIoControl($stream.SafeFileHandle,
            0x000900C4, [IntPtr]::Zero, 0, [IntPtr]::Zero, 0,
            [ref] $returned, [IntPtr]::Zero)) {
            throw "FSCTL_SET_SPARSE failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        $stream.SetLength($length)
        $pattern = New-Object byte[] 65536
        for ($index = 0; $index -lt $pattern.Length; $index++) {
            $pattern[$index] = $index % $Modulo
        }
        $stream.Write($pattern, 0, $pattern.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
}

switch ($Mode) {
    'create' {
        $paths = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
        foreach ($path in $paths) { New-SparseFixture $path }
        @{ count = $paths.Count; logical_bytes_each = $length; sparse = $true } |
            ConvertTo-Json -Compress
    }
    'probe' {
        $paths = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
        $result = foreach ($path in $paths) {
            $stream = $null
            try {
                $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
                @{ file = [System.IO.Path]::GetFileName($path); exclusive = $true }
            } catch {
                $exception = $_.Exception
                while ($exception.InnerException) { $exception = $exception.InnerException }
                $win32 = $exception.HResult -band 0xffff
                if ($win32 -ne 32 -and $win32 -ne 33) { throw }
                @{ file = [System.IO.Path]::GetFileName($path); exclusive = $false; win32 = $win32 }
            } finally {
                if ($stream) { $stream.Dispose() }
            }
        }
        ConvertTo-Json -InputObject @($result) -Compress
    }
    'metrics' {
        $agentProcess = Get-Process -Id $AgentProcessId
        $agentProcess.Refresh()
        @{
            pid = $agentProcess.Id
            working_set_bytes = $agentProcess.WorkingSet64
            private_bytes = $agentProcess.PrivateMemorySize64
            total_handle_count = $agentProcess.HandleCount
        } | ConvertTo-Json -Compress
    }
    'edit' {
        $before = Get-Item -LiteralPath $Target
        $modified = $before.LastWriteTimeUtc
        $originalLength = $before.Length
        $stream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Write,
            ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
        try {
            $stream.Position = 33554432L
            $bytes = New-Object byte[] 4096
            for ($index = 0; $index -lt $bytes.Length; $index++) { $bytes[$index] = 165 }
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally { $stream.Dispose() }
        [System.IO.File]::SetLastWriteTimeUtc($Target, $modified)
        $after = Get-Item -LiteralPath $Target
        @{
            before_length = $originalLength; after_length = $after.Length
            modified_before_ticks = $modified.Ticks.ToString()
            modified_after_ticks = $after.LastWriteTimeUtc.Ticks.ToString()
            restored_modified_exactly = $modified.Ticks -eq $after.LastWriteTimeUtc.Ticks
        } | ConvertTo-Json -Compress
    }
    'replace' {
        $before = Get-Item -LiteralPath $Target
        $modified = $before.LastWriteTimeUtc
        $originalLength = $before.Length
        $replacement = "$Target.new"
        New-SparseFixture $replacement 127
        [System.IO.File]::SetLastWriteTimeUtc($replacement, $modified)
        [System.IO.File]::Replace($replacement, $Target, "$Target.old")
        [System.IO.File]::SetLastWriteTimeUtc($Target, $modified)
        $after = Get-Item -LiteralPath $Target
        @{
            before_length = $originalLength; after_length = $after.Length
            modified_before_ticks = $modified.Ticks.ToString()
            modified_after_ticks = $after.LastWriteTimeUtc.Ticks.ToString()
            restored_modified_exactly = $modified.Ticks -eq $after.LastWriteTimeUtc.Ticks
        } | ConvertTo-Json -Compress
    }
    'truncate' {
        $stream = [System.IO.File]::Open($Target, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Write,
            ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
        try { $stream.SetLength(0); $stream.Flush($true) } finally { $stream.Dispose() }
        @{ after_length = (Get-Item -LiteralPath $Target).Length } | ConvertTo-Json -Compress
    }
}
