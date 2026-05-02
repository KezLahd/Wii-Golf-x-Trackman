"""
TrackMan -> Dolphin (Wii Sports Resort Golf) memory-poke bridge.

Listens to the TrackMan radar's WebSocket, and on each Measurement event writes
the shot's launch velocity directly into the active RPGlfBall struct in
Dolphin's emulated MEM1 — bypassing the MotionPlus swing detector entirely.

Memory layout (NTSC-U, verified 2026-04-25 via DME in-flight capture):
  0x806F54E8  spSimBall  (u32 -> RPGlfBall*)
  +0x60       mIsMoving  (byte: 1 = ball in flight)
  +0x94..9C   velocity "impulse" (3 BE floats, wu/frame, set on impact)
  +0xA0..A8   velocity "current" (3 BE floats, wu/frame, integrated each frame)

World units: 1 meter = 10 wu. Game ticks at 60 Hz, integrating velocity
per frame, so a real-world speed of S m/s is stored as S * 10 / 60 wu/frame.

Wii is big-endian. Dolphin's emulated MEM1 in the host process is big-endian
on disk, so all 4-byte reads/writes must byte-swap.
"""

import asyncio
import json
import os
import struct
import sys
import time
from dataclasses import dataclass

import requests
import websockets
import pymem
import pymem.process

# Always tee print() output to bridge.log so we can read the log from another
# terminal (and so pythonw.exe runs are observable). Original stdout (if any)
# is preserved for live console runs.
LOG_PATH = os.path.join(os.path.dirname(__file__), "bridge.log")

class _Tee:
    def __init__(self, *streams):
        self.streams = [s for s in streams if s is not None]
    def write(self, data):
        for s in self.streams:
            try:
                s.write(data); s.flush()
            except Exception:
                pass
    def flush(self):
        for s in self.streams:
            try: s.flush()
            except Exception: pass

_log_file = open(LOG_PATH, "a", buffering=1, encoding="utf-8")
sys.stdout = _Tee(sys.__stdout__, _log_file)
sys.stderr = _Tee(sys.__stderr__, _log_file)
print(f"\n=== bridge started {time.strftime('%Y-%m-%d %H:%M:%S')} ===")

# ─── Config ────────────────────────────────────────────────────────────────
RADAR_HOST = "192.168.0.9"
RADAR_USER = "Admin"

# WSR Golf NTSC-U memory map
SP_SIM_BALL          = 0x806F54E8
BALL_IS_MOVING_OFF   = 0x60
# Velocity offsets (verified 2026-04-25 via in-flight struct dump diff —
# integrator reads from +0x88, impulse copy at +0x7C). Earlier guesses of
# +0x94/+0xA0 were HUD mirrors and ignored by physics.
BALL_VEL_IMPULSE_OFF = 0x7C   # constant, set at impact
BALL_VEL_CURRENT_OFF = 0x88   # decays per frame, what the integrator reads

MEM1_BASE_GAME = 0x80000000
MEM1_END_GAME  = 0x81800000  # 24 MiB

WU_PER_METER = 10.0
FPS          = 60.0


# ─── Dolphin memory accessor ───────────────────────────────────────────────
class DolphinMemory:
    def __init__(self):
        self.pm = None
        self.mem1_host_base = None  # host address that maps to game 0x80000000

    def attach(self):
        """Attach to Dolphin.exe and locate the emulated MEM1 region."""
        self.pm = pymem.Pymem("Dolphin.exe")

        # Walk the process's committed memory regions and find one that, when
        # treated as game 0x80000000, dereferences the spSimBall sentinel into
        # a plausible MEM1 pointer. This is the same approach DME uses.
        from ctypes import (
            wintypes, c_size_t, c_ulong, c_void_p, byref, sizeof, Structure
        )
        from ctypes import windll

        class MEMORY_BASIC_INFORMATION(Structure):
            _fields_ = [
                ("BaseAddress", c_void_p),
                ("AllocationBase", c_void_p),
                ("AllocationProtect", c_ulong),
                ("__alignment1", c_ulong),
                ("RegionSize", c_size_t),
                ("State", c_ulong),
                ("Protect", c_ulong),
                ("Type", c_ulong),
                ("__alignment2", c_ulong),
            ]

        VirtualQueryEx = windll.kernel32.VirtualQueryEx
        addr = 0
        max_addr = 0x7FFFFFFF0000  # 64-bit user-space ceiling

        while addr < max_addr:
            mbi = MEMORY_BASIC_INFORMATION()
            ret = VirtualQueryEx(
                self.pm.process_handle,
                c_void_p(addr),
                byref(mbi),
                sizeof(mbi),
            )
            if not ret:
                break

            # MEM_COMMIT and writable, large enough to hold MEM1 (24 MiB)
            is_committed = (mbi.State == 0x1000)
            is_rw = bool(mbi.Protect & (0x04 | 0x40))  # PAGE_READWRITE or PAGE_EXECUTE_READWRITE
            is_big = mbi.RegionSize >= 0x1800000

            if is_committed and is_rw and is_big:
                # Try treating mbi.BaseAddress as game 0x80000000 and dereference
                # the sentinel pointer. Read 4 BE bytes -> u32.
                try:
                    base = mbi.BaseAddress or 0
                    test_host = base + (SP_SIM_BALL - MEM1_BASE_GAME)
                    raw = self.pm.read_bytes(test_host, 4)
                    val = struct.unpack(">I", raw)[0]
                    if MEM1_BASE_GAME <= val < MEM1_END_GAME:
                        self.mem1_host_base = base
                        print(f"[mem] attached. MEM1 host base = 0x{base:x}, "
                              f"sentinel [0x{SP_SIM_BALL:x}] = 0x{val:x}")
                        return
                except Exception:
                    pass

            addr += mbi.RegionSize or 0x1000

        raise RuntimeError(
            "MEM1 not located. Is WSR Golf loaded past the title screen?"
        )

    def _host(self, game_addr):
        if self.mem1_host_base is None:
            raise RuntimeError("not attached")
        if not (MEM1_BASE_GAME <= game_addr < 0x94000000):
            raise ValueError(f"game addr 0x{game_addr:x} out of range")
        return self.mem1_host_base + (game_addr - MEM1_BASE_GAME)

    def read_u32(self, game_addr):
        raw = self.pm.read_bytes(self._host(game_addr), 4)
        return struct.unpack(">I", raw)[0]

    def read_float(self, game_addr):
        raw = self.pm.read_bytes(self._host(game_addr), 4)
        return struct.unpack(">f", raw)[0]

    def write_float(self, game_addr, value):
        self.pm.write_bytes(self._host(game_addr), struct.pack(">f", value), 4)

    def write_byte(self, game_addr, value):
        self.pm.write_bytes(self._host(game_addr), struct.pack("B", value & 0xff), 1)


# ─── Velocity computation ──────────────────────────────────────────────────
@dataclass
class ShotVelocity:
    vx: float
    vy: float
    vz: float

    def __str__(self):
        return f"({self.vx:.3f}, {self.vy:.3f}, {self.vz:.3f})"


def compute_velocity(ball_speed_mps, launch_angle_deg, launch_dir_deg):
    """
    Convert TrackMan launch parameters to a (vx, vy, vz) world-frame velocity
    in wu/frame, ready to write into the ball struct.

    World-frame convention (verified empirically on test hole, may need a
    per-hole tee-yaw rotation later):
      +X = right of tee
      +Y = world up
      -Z = downrange / forward from tee
    """
    angle_rad = launch_angle_deg * 3.141592653589793 / 180.0
    dir_rad   = launch_dir_deg   * 3.141592653589793 / 180.0

    import math
    forward = ball_speed_mps * math.cos(angle_rad)
    up      = ball_speed_mps * math.sin(angle_rad)

    vx_mps =  forward * math.sin(dir_rad)
    vy_mps =  up
    vz_mps = -forward * math.cos(dir_rad)

    scale = WU_PER_METER / FPS
    return ShotVelocity(vx_mps * scale, vy_mps * scale, vz_mps * scale)


# ─── Pending-shot state ────────────────────────────────────────────────────
# When a TrackMan Measurement arrives we don't write to memory immediately —
# the game's state machine is in "aim" phase and our writes get ignored.
# Instead we stash the computed velocity here, and a polling loop watches for
# the user to commit a swing via keyboard in WSR Golf. The moment mIsMoving
# transitions 0 → 1 (game has entered FLIGHT phase), we inject TrackMan's
# velocity in place of whatever the game's own swing detector wrote.
PENDING_TIMEOUT_SEC = 30.0

class PendingShot:
    def __init__(self):
        self.vel = None           # ShotVelocity or None
        self.created_at = 0.0
        self.payload = None

    def stash(self, vel: 'ShotVelocity', payload: dict):
        self.vel = vel
        self.created_at = time.time()
        self.payload = payload

    def is_expired(self):
        return self.vel is None or (time.time() - self.created_at) > PENDING_TIMEOUT_SEC

    def consume(self):
        v = self.vel
        self.vel = None
        return v


PENDING = PendingShot()


def stash_shot(payload: dict):
    """Compute velocity from TrackMan Measurement and hold for the next swing
    commit. No memory writes here."""
    bs = float(payload.get("BallSpeed",       0))
    la = float(payload.get("LaunchAngle",     0))
    ld = float(payload.get("LaunchDirection", 0))
    vel = compute_velocity(bs, la, ld)
    PENDING.stash(vel, payload)
    print(f"[tm] stashed shot: BallSpeed={bs:.1f}m/s LaunchAngle={la:.1f}° "
          f"LaunchDir={ld:.1f}° v={vel}  swing within {PENDING_TIMEOUT_SEC:.0f}s")


def write_velocity(mem: DolphinMemory, ball_ptr: int, vel: 'ShotVelocity',
                   write_impulse=True, write_current=True):
    """Low-level: write velocity to +0x94 (impulse) and/or +0xA0 (current)."""
    try:
        if write_impulse:
            mem.write_float(ball_ptr + BALL_VEL_IMPULSE_OFF + 0, vel.vx)
            mem.write_float(ball_ptr + BALL_VEL_IMPULSE_OFF + 4, vel.vy)
            mem.write_float(ball_ptr + BALL_VEL_IMPULSE_OFF + 8, vel.vz)
        if write_current:
            mem.write_float(ball_ptr + BALL_VEL_CURRENT_OFF + 0, vel.vx)
            mem.write_float(ball_ptr + BALL_VEL_CURRENT_OFF + 4, vel.vy)
            mem.write_float(ball_ptr + BALL_VEL_CURRENT_OFF + 8, vel.vz)
        return True
    except Exception as e:
        print(f"[mem] write failed: {e}")
        return False


async def swing_watcher(mem: DolphinMemory, poll_hz: float = 240.0):
    """Continuously write the latest TrackMan velocity to the ball struct
    as long as we have a pending shot. By writing both BEFORE swing commit
    (so our value is the seed) and DURING flight (so we override anything
    the integrator computes), we maximize the chance our velocity drives
    the trajectory.

    No detection / edge-trigger — just constant pinning. Stops when the
    pending shot expires or ball stops moving for >0.5s."""
    interval = 1.0 / poll_hz
    moving_zero_since = None

    while True:
        await asyncio.sleep(interval)

        if PENDING.is_expired():
            moving_zero_since = None
            continue

        vel = PENDING.vel  # peek, don't consume — keep pinning until expired
        if vel is None:
            continue

        try:
            ball_ptr = mem.read_u32(SP_SIM_BALL)
            if not (MEM1_BASE_GAME <= ball_ptr < MEM1_END_GAME):
                continue
            is_moving = mem.pm.read_bytes(mem._host(ball_ptr + BALL_IS_MOVING_OFF), 1)[0]
            lifetime  = mem.read_u32(ball_ptr + 0x54)
        except Exception:
            continue

        # Pin velocity to both impulse and current.
        write_velocity(mem, ball_ptr, vel,
                       write_impulse=True, write_current=True)

        # DIAGNOSTIC: also teleport the ball to a recognisable position so
        # we can confirm whether the ball at this pointer is the visible one.
        # Y=+500 is high in the sky in world units (50m up).
        try:
            mem.write_float(ball_ptr + 0x30, 0.0)
            mem.write_float(ball_ptr + 0x34, 500.0)
            mem.write_float(ball_ptr + 0x38, 0.0)
        except Exception:
            pass

        # Once ball has been stationary for >0.5s after a flight, expire the
        # pending shot so we don't keep injecting forever.
        if is_moving == 0:
            if moving_zero_since is None:
                moving_zero_since = time.time()
            elif (time.time() - moving_zero_since) > 0.5 and lifetime > 0:
                # Had a flight, ball now stopped — clear pending shot
                age = time.time() - PENDING.created_at
                if age > 1.0:  # don't expire shot we just received
                    print(f"[mem] ball stopped (lifetime={lifetime}). Clearing pending after {age:.1f}s")
                    PENDING.consume()
                    moving_zero_since = None
        else:
            moving_zero_since = None


# ─── TrackMan side ─────────────────────────────────────────────────────────
def login():
    """HTTP-login to the radar, returns the session_id cookie."""
    r = requests.post(
        f"http://{RADAR_HOST}/auth/login",
        data={"username": RADAR_USER, "action": "Force"},
        allow_redirects=False,
    )
    sc = r.headers.get("set-cookie", "")
    for part in sc.split(";"):
        part = part.strip()
        if part.startswith("session_id="):
            return part.split("=", 1)[1]
    raise RuntimeError(f"no session cookie (status {r.status_code})")


def keepalive(session):
    requests.post(
        f"http://{RADAR_HOST}/api/ValidateSession",
        cookies={"session_id": session},
    )


def arm_radar(session):
    requests.post(
        f"http://{RADAR_HOST}/api/Setup",
        json={"IsMeasuring": True},
        cookies={"session_id": session},
    )


async def keepalive_loop(session):
    while True:
        await asyncio.sleep(10)
        try:
            keepalive(session)
        except Exception as e:
            print(f"[tm] keepalive failed: {e}")


async def rearm_loop(session):
    while True:
        await asyncio.sleep(45)
        try:
            arm_radar(session)
        except Exception as e:
            print(f"[tm] rearm failed: {e}")


async def run_bridge(mem: DolphinMemory):
    session = login()
    print("[tm] authenticated as Admin")

    # background keepalive + rearm + memory swing watcher
    asyncio.create_task(keepalive_loop(session))
    asyncio.create_task(rearm_loop(session))
    asyncio.create_task(swing_watcher(mem))

    uri = f"ws://{RADAR_HOST}/ws"
    async with websockets.connect(
        uri,
        additional_headers={"Cookie": f"session_id={session}"},
    ) as ws:
        await ws.send(json.dumps({
            "Type": "Subscribe",
            "Payload": {"MessageList": ["ALL"]},
        }))
        await asyncio.sleep(0.3)
        arm_radar(session)
        print("[tm] subscribed + radar armed. Hit a ball.\n")

        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                print(f"[ws raw non-json] {raw[:200]}")
                continue

            t = msg.get("Type")
            if t == "Ping":
                await ws.send(json.dumps({"Type": "Pong", "Payload": None}))
                continue

            # Log every event so we can see what radar is actually sending.
            if t != "TrackerState" or msg.get("Payload", {}).get("TrackerState") != "Idle":
                print(f"[ws] {t}  {json.dumps(msg.get('Payload'))[:160]}")

            if t == "TrackerState":
                state = msg.get("Payload", {}).get("TrackerState")
                if state and state != "Idle":
                    print(f"  -> {state}")

            if t == "Measurement" and msg.get("Payload", {}).get("Kind") == "Measurement":
                stash_shot(msg["Payload"])


def main():
    mem = DolphinMemory()
    try:
        mem.attach()
    except Exception as e:
        print(f"[mem] attach failed: {e}")
        print("[mem] bridge will not run without Dolphin attached. Start "
              "Dolphin + WSR Golf, get past the title screen, then re-run.")
        sys.exit(1)

    while True:
        try:
            asyncio.run(run_bridge(mem))
        except KeyboardInterrupt:
            print("\n[bridge] stopped")
            return
        except Exception as e:
            print(f"[bridge] error: {e}, reconnecting in 3s...")
            time.sleep(3)


if __name__ == "__main__":
    main()
