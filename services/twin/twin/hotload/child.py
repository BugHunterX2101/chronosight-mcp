"""Patch child process (TECHNICAL §6.11). Run as: python -I child.py <workdir>

Standalone on purpose: -I keeps the parent's paths out, so this file imports only the
stdlib and msgpack, then the candidate's own controller.py/params.py/abi.py from <workdir>.
Frames: 4-byte big-endian length + msgpack map, at most 64 KB.
"""
import os
import struct
import sys
import traceback

MAX_FRAME = 64 * 1024


def _limits() -> None:
    try:
        import resource
    except ImportError:          # not on Linux: the container is the boundary
        return
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (20, 20))


def main() -> None:
    _limits()
    import msgpack

    workdir = os.path.abspath(sys.argv[1])
    os.chdir(workdir)
    sys.path.insert(0, workdir)
    rd, wr = sys.stdin.buffer, sys.stdout.buffer
    sys.stdout = sys.stderr      # a stray print() must not corrupt the pipe

    def send(msg: dict) -> None:
        body = msgpack.packb(msg, use_bin_type=True)
        wr.write(struct.pack(">I", len(body)) + body)
        wr.flush()

    def recv() -> dict | None:
        head = rd.read(4)
        if len(head) < 4:
            return None
        (n,) = struct.unpack(">I", head)
        if n > MAX_FRAME:
            raise ValueError("frame too large")
        return msgpack.unpackb(rd.read(n), raw=False)

    def fail(exc: BaseException) -> None:
        tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
        send({"t": "err", "type": type(exc).__name__, "msg": str(exc)[:500], "tb": "".join(tb)[-4000:]})

    ctl = None
    try:
        import abi
        import controller
        import params
        State = abi.State
    except BaseException as exc:  # noqa: BLE001
        fail(exc)
        return
    while True:
        msg = recv()
        if msg is None:
            return
        t = msg.get("t")
        try:
            if t == "init":
                ctl = controller.Controller(dict(params.PARAMS, **(msg.get("params") or {})))
                send({"t": "ready"})
            elif t == "reset":
                ctl = controller.Controller(dict(params.PARAMS))
                send({"t": "ready"})
            elif t == "step":
                cmd = ctl.step(State(*msg["state"]), msg["dt"])
                writes = [[int(a), int(v)] for a, v in (cmd.reg_writes or ())]
                send({"t": "cmd", "u": float(cmd.u), "regWrites": writes})
            else:
                send({"t": "err", "type": "ProtocolError", "msg": f"unknown message {t!r}", "tb": ""})
        except BaseException as exc:  # noqa: BLE001
            fail(exc)
            return


if __name__ == "__main__":
    main()
