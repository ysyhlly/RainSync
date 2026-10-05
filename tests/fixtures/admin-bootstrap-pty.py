#!/usr/bin/env python3
"""Owned synthetic terminal driver. Never emits password input or environment."""
import fcntl
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time

config = json.loads(sys.stdin.readline())
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
original_flags = fcntl.fcntl(slave, fcntl.F_GETFL)
transcript = bytearray()
seen = set()
markers = [value.encode() for value in config.get("secret_markers", [])]

def emit(value):
    print(json.dumps(value), flush=True)

def controlling_terminal():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

child = subprocess.Popen(
    [config["binary"], *config.get("args", ["init-admin", "--username", config["username"]])],
    stdin=slave,
    stdout=slave,
    stderr=subprocess.PIPE if config.get("redirect_stderr") else slave,
    env=config["env"],
    preexec_fn=controlling_terminal,
)
emit({"stage": "started", "pid": child.pid})
deadline = time.monotonic() + 45
failed = None
try:
    while child.poll() is None:
        if time.monotonic() >= deadline:
            raise TimeoutError("bootstrap PTY did not finish within 45 seconds")
        readable, _, _ = select.select([master, sys.stdin], [], [], 0.1)
        if master in readable:
            transcript.extend(os.read(master, 65536))
            for stage, prompt in [("password", b"Administrator password: "), ("confirmation", b"Confirm password: ")]:
                if stage not in seen and prompt in transcript:
                    seen.add(stage)
                    emit({"stage": stage, "echo_enabled": bool(termios.tcgetattr(slave)[3] & termios.ECHO)})
        if sys.stdin in readable:
            line = sys.stdin.readline()
            if not line:
                raise RuntimeError("terminal control input closed before child exit")
            command = json.loads(line)
            if "input" in command:
                os.write(master, command["input"].encode())
            elif "signal" in command:
                os.kill(child.pid, getattr(signal, command["signal"]))
            else:
                raise ValueError("unsupported terminal control command")
except Exception as error:
    failed = str(error)
finally:
    if child.poll() is None:
        child.kill()
    code = child.wait()
    # The driver retains the slave so terminal restoration is inspectable after
    # the bootstrap process exits, rather than inferred from process completion.
    for _ in range(20):
        readable, _, _ = select.select([master], [], [], 0.01)
        if not readable:
            break
        transcript.extend(os.read(master, 65536))
    if child.stderr is not None:
        transcript.extend(child.stderr.read())
    restored = termios.tcgetattr(slave) == original
    flags_restored = fcntl.fcntl(slave, fcntl.F_GETFL) == original_flags
    no_echo = not any(marker and marker in transcript for marker in markers)
    safe = bytes(transcript)
    for marker in markers:
        if marker:
            safe = safe.replace(marker, b"[REDACTED SYNTHETIC INPUT]")
    os.close(master)
    os.close(slave)
    emit({"stage": "finished", "pid": child.pid, "code": code,
          "terminal_settings_restored": restored, "terminal_flags_restored": flags_restored,
          "secret_echo_detected": not no_echo,
          "output": safe.decode(errors="replace"), "driver_error": failed})
