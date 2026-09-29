"""Launch only the isolated Node load runner in a hidden new Windows console."""
import json
import os
import subprocess
import sys
import threading

if sys.platform != "win32":
    raise SystemExit("Windows only")
with open(sys.argv[1], encoding="utf-8") as source:
    spec = json.load(source)
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = subprocess.SW_HIDE
environment = os.environ.copy()
environment.update(spec["env"])
with open(spec["log"], "wb") as log:
    child = subprocess.Popen(
        [spec["exe"], *spec["args"]], cwd=spec["cwd"], env=environment,
        stdin=subprocess.DEVNULL, stdout=log, stderr=log, startupinfo=startup,
        creationflags=subprocess.CREATE_NEW_CONSOLE,
    )
    def cancel():
        if os.read(sys.stdin.fileno(), 16) in (b"kill\n", b""):
            if child.poll() is None:
                child.kill()
    threading.Thread(target=cancel, daemon=True).start()
    print(json.dumps({"pid": child.pid}), flush=True)
    print(json.dumps({"exit_code": child.wait()}), flush=True)

