"""Isolated hidden-console test helper; never attaches to the user's console."""
import ctypes
from ctypes import wintypes
import json
import os
import subprocess
import sys
import threading
import time

if sys.platform != "win32":
    raise SystemExit("Windows only")


def emit(value):
    print(json.dumps(value), flush=True)


mode = sys.argv[1]
if mode == "launch":
    with open(sys.argv[2], encoding="utf-8") as source:
        spec = json.load(source)
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    with open(spec["log"], "wb") as log:
        child = subprocess.Popen(
            [spec["exe"]], env=spec["env"], stdin=subprocess.DEVNULL,
            stdout=log, stderr=log, startupinfo=startup,
            creationflags=subprocess.CREATE_NEW_CONSOLE,
        )
        def cancel():
            if os.read(sys.stdin.fileno(), 16) in (b"kill\n", b""):
                child.kill()  # Popen retains the original process HANDLE.
        threading.Thread(target=cancel, daemon=True).start()
        emit({"pid": child.pid})
        emit({"exit_code": child.wait()})
elif mode == "signal":
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.FreeConsole()
    if not kernel.AttachConsole(int(sys.argv[2])):
        raise ctypes.WinError(ctypes.get_last_error())
    # This helper temporarily shares only the isolated test console. Protect it
    # from the broadcast; descendants launched with CREATE_NO_WINDOW do not
    # receive the console event and therefore require the service's tree cleanup.
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
    callback = callback_type(lambda event: event in (0, 1))
    kernel.SetConsoleCtrlHandler.argtypes = [callback_type, wintypes.BOOL]
    if not kernel.SetConsoleCtrlHandler(callback, True):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.GenerateConsoleCtrlEvent(int(sys.argv[3]), 0):
        raise ctypes.WinError(ctypes.get_last_error())
    time.sleep(0.1)
    kernel.FreeConsole()
    emit({"delivered": True})
elif mode == "watch":
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForMultipleObjects.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE), wintypes.BOOL, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handles = []
    try:
        for pid in json.loads(sys.argv[2]):
            handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
            if not handle:
                raise ctypes.WinError(ctypes.get_last_error())
            handles.append(handle)
        array = (wintypes.HANDLE * len(handles))(*handles)
        emit({"watching": True})
        result = kernel.WaitForMultipleObjects(len(handles), array, True, 30000)
        if result != 0:
            raise RuntimeError(f"process handles did not exit: {result}")
        emit({"exited": True})
    finally:
        for handle in handles:
            kernel.CloseHandle(handle)
else:
    raise SystemExit("unknown helper mode")
