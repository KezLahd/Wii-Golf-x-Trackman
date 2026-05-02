<h1 align="center">Wii Golf × TrackMan</h1>

<p align="center">
  <em>Swing a real golf club at a TrackMan 4 radar. The Wiimote swings with you. The ball flies on Wii Sports Resort.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TrackMan_4-2D5F3F?style=for-the-badge&labelColor=16130F" alt="TrackMan 4"/>
  <img src="https://img.shields.io/badge/Dolphin-2D5F3F?style=for-the-badge&labelColor=16130F" alt="Dolphin"/>
  <img src="https://img.shields.io/badge/WSR_Golf-2D5F3F?style=for-the-badge&labelColor=16130F" alt="WSR Golf"/>
  <img src="https://img.shields.io/badge/Status-Working-16130F?style=for-the-badge&labelColor=2D5F3F" alt="Status"/>
</p>

<br/>

## What this is

A bridge that turns a real-world golf swing — measured by a [TrackMan 4](https://trackman.com/golf/trackman-4) launch monitor — into a synthetic Wiimote MotionPlus signal that Wii Sports Resort Golf accepts as a swing.

You hit a real ball. TrackMan reads ball speed, launch angle, direction, spin. The bridge converts that shot into the exact accelerometer + gyro waveform a Wiimote would have produced if a person had swung the same club, and pipes it into Dolphin over the cemuhook DSU motion protocol. The game commits the swing.

The result is closer to driving range golf than to a video game.

<br/>

## How it works

```
 TrackMan 4 radar           tm-dolphin-bridge            Dolphin (WSR Golf)
 ┌─────────────────┐       ┌──────────────────┐         ┌──────────────────┐
 │ WebSocket /ws   │──────▶│ ball metrics →   │────────▶│ DSU motion slot  │
 │ Measurement     │       │ swing curve gen  │  UDP    │ MotionPlus emu   │
 │ {BallSpeed,     │       │ (60 Hz IMU)      │  26760  │ accepts swing    │
 │  Launch, Spin}  │       └──────────────────┘         └──────────────────┘
 └─────────────────┘
```

Two implementations live in this repo:

- **`bridge.mjs`** &nbsp; The main Node bridge. Generates a four-phase synthetic swing (backswing → pause at top → downswing → follow-through) as continuous accel + gyro telemetry, scaled to ball speed. Calibrated against Dolphin's MotionPlus.cpp clamps and real-Wiimote swing measurements so WSR Golf's swing detector commits every shot.
- **`bridge.py`** &nbsp; A second approach that pokes the ball-velocity struct directly in Dolphin's emulated MEM1, bypassing the swing detector entirely. Useful when motion-emulation tuning falls over.

<br/>

## Files

| File | What it does |
|---|---|
| `bridge.mjs` | Node bridge — TrackMan WS subscriber + DSU motion server + swing curve generator. The main one. |
| `bridge.py` | Python bridge — same TrackMan subscription, but writes ball velocity straight into Dolphin's emulated MEM1 via `pymem`. |
| `dolphin-mem.mjs` | Locates Dolphin's MEM1 host base by sentinel-validating committed RW regions. Mirrors `dolphin-memory-engine`'s discovery algorithm. |
| `dsu-server.mjs` | Standalone DSU / cemuhook motion server (no TrackMan dep) — useful for testing Dolphin subscription independently. |
| `listen.mjs` | Read-only TrackMan listener. Prints every shot to stdout in m/s + mph + yards. Used during calibration. |
| `probe-ws.mjs` | One-shot WebSocket probe to dump all messages from the radar — used while reverse-engineering the TrackMan API. |
| `analyze_dump.py` | Offline analysis of captured shot logs. |

<br/>

## The swing curve, briefly

Real Wii Sports Resort golf swings on MotionPlus peak around 1200–1800 deg/s on the dominant gyro axis with a 3–5g impact spike at the bottom of the arc. Dolphin hard-clamps gyro at ±2259 deg/s — exceeding it produces a flat-topped waveform with *less* integrated angular displacement than a sharper, lower peak, which is why early aggressive tuning made soft shots fill the meter more than hard ones.

The curve in `bridge.mjs` is a `C¹`-smooth four-phase profile parameterised on `BallSpeed`:

| Phase | Drive (60 m/s+) | Chip (5–15 m/s) | Putt (<4 m/s) |
|---|---|---|---|
| Backswing | 1200 ms / 180° | 1200 ms / ~85° | 550 ms / 25° |
| Pause at top | 200 ms | 200 ms | 130 ms |
| Downswing | 600 ms | 600 ms | 380 ms |
| Follow-through | 400 ms | 400 ms | 250 ms |
| Impact peak | up to 10g | ~3.9g | ~1.5g |

Every comment block in the source is calibration history. Read them.

<br/>

## Run it

Prereqs:

- TrackMan 4 reachable on the LAN (set `RADAR` in `bridge.mjs` to its IP)
- Dolphin running with cemuhook input enabled (DSU server: `127.0.0.1:26760`, slot 0)
- Wii Sports Resort Golf, past the title screen

```bash
npm install
node bridge.mjs
```

Or, for the memory-poke variant (requires Dolphin running and a Python env with `pymem`, `websockets`, `requests`):

```bash
python bridge.py
```

<br/>

## Status

Working. Every shot commits — drives, irons, wedges, chips, putts. The putter profile is currently disabled (`PUTT_BALLSPEED_MAX = 0`) because pure-putt amplitudes occasionally failed to commit; trade-off is over-powered putts in exchange for 100% commit rate. Dialing this in is the next pass.

<br/>

---

<p align="center">
  <sub>Built on the TrackMan at home. Not affiliated with TrackMan A/S, Nintendo, or anyone reasonable.</sub>
  <br/>
  <sub>Part of <a href="https://github.com/KezLahd">Kez's</a> ongoing campaign to put a radar on everything.</sub>
</p>
