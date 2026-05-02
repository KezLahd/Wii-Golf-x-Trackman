# Wii Sports Golf — Calibration Findings

**Last updated:** 2026-05-02
**Bridge file:** `bridge-test.mjs` on the `test-curve` branch
**Game:** Original Wii Sports Golf (NOT WSR Golf — different game, different mechanics)

---

## TL;DR — what works right now

- **End-to-end shot injection works.** `node inject.mjs raw …` programmatically fires a swing in Dolphin with comparable in-game behaviour to a manual hit. This is a major win — every parameter we want to test is directly controllable from the CLI.
- **Power lever discovered: backswing depth (`backAmp`).** Linear 37° → 115° maps to ~2.1 → 4 bars in-game. Floor is hard at 37° (36° no longer triggers a hit). Ceiling is ~115°; past 130° starts going over 4 bars; past 190° starts dropping shots; past 200° unreliable.
- **Two strong secondary levers:** `follow` (0° → 120° = 1.5 → 4 bars) and `peakG` (5g → 15g = +0.3 → +1g of fill, saturates around 15g).
- **Curve is impossible in WS Golf.** Confirmed by exhaustive empirical testing AND by external research — original WS Golf has no hook/slice/draw/fade physics. Curve work belongs in WSR Golf.
- **Direction control is D-pad-driven** in WS Golf — and our DSU D-pad implementation is currently NOT working despite correct bindings (open issue, see below).

---

## The methodology (the "brains" of this project)

This is the actual breakthrough — much more than any individual finding. Apply this same process verbatim to WSR Golf.

### Single-lever isolated sweep

When trying to figure out what controls X (power, direction, anything), don't tweak multiple knobs at once. Don't iterate on intuition. Don't compound-scale parameters and hope for the best.

Instead:

1. **Identify ALL the parameters you can control.** For us in WS Golf that was: backAmp, follow, pause, downMs, backMs, followMs, peakG, impactWidthMs, impactAxis, cursor X, cursor Y, swing-plane tilt, gyro signals, button presses.

2. **Pick a stable baseline** where every knob is set to a "moderate" value and the swing reliably fires (e.g. backAmp=80, follow=30, pause=200, peakG=5, cursor pinned at screen center). The baseline must be ABOVE the game's swing-detection threshold so RNG doesn't muddy the signal — minimal motion configs near the threshold give random commits.

3. **Sweep ONE knob across a wide range** while holding everything else at baseline. 4–6 values, 3+ reps each.

4. **Look at the bar fill (or other output) at each value:**
   - Wide spread → that knob IS a lever for whatever you're measuring.
   - Flat output → it's NOT a lever, drop it and move on.
   - Inconsistent reps → either RNG (you're near the detection threshold), or the knob interacts with something else.

5. **Repeat for every parameter.** This is faster than it sounds — most parameters get ruled out in 2–3 minutes.

6. **Once you find a lever, calibrate it.** Map the input you care about (e.g. TrackMan ball speed) onto that lever's range.

### Why this beats guessing

We spent the first half of this session compound-scaling 4–5 parameters at once based on intuition. Every tweak either did nothing or aborted the swing. Once we switched to single-lever sweeps with the cursor pinned (eliminating one big confounder), we found backAmp as the primary lever in 15 minutes.

### Critical: pin the cursor

The Dolphin IR pointer follows the OS mouse cursor by default. The IR pointer position affects bar fill (top-left = 3.2 bars, top-right = 2.6 bars, bottom-right = no shot). If the cursor drifts even slightly between shots, you get RNG that masquerades as motion-parameter variance.

Our `inject.mjs` uses PowerShell `[System.Windows.Forms.Cursor]::Position` to pin the cursor at a fixed screen coordinate (default `960,540` for 1080p) right before each shot fires. Future testing on WSR Golf should pin the cursor identically before assuming any other variable is a "lever."

**Earlier in this session we observed a bar-fill regression "from 4 → 2.8 bars" mid-session that we initially blamed on Dolphin's IMU integrator drifting.** It wasn't. It was the cursor moving between manual clicks introducing IR pointer variance. Once cursor was pinned, the 4-bar response returned. Lesson: rule out cursor before blaming Dolphin state.

---

## Lever findings table

| Lever | Affects power? | Affects direction? | Notes |
|-------|----------------|---------------------|-------|
| **backAmp** | ✓ primary | ✗ | Floor 37° (36° = no hit; 37° = ~2.1 bars). Ceiling ~115° = 4 bars clean. >130° starts overshooting. >190° starts dropping shots. >200° unreliable. |
| **follow** | ✓ secondary | ✗ | Linear: 0° → 1.5 bars, 120° → 4 bars. NO trigger floor (any value >0 fires the swing). |
| **peakG** | ✓ fine-tune | ✗ | At stable baseline (backAmp=80+follow=30): 1g→2.4 bars, 5g→2.9, 15g→3.2 (saturates). Below ~5g causes RNG when motion is also minimal. |
| **pause** | ✗ | ✗ | Flat 3.3 bars across 50ms → 3000ms. Not a lever despite the visual "pause at top of backswing" being noticeable. |
| **impactAxis** | magnitude only | ✗ | Z=3.0 (canonical), Y=2.3 (weak), X=2.8. Use Z. Never produces curve. |
| **cursor X/Y** | ✓ varies 2.2–3.3 | ✗ | Cursor position changes power across the screen, but ball direction is dead straight regardless. **Must pin for clean tests.** |
| **swing-plane tilt** (`tiltDeg`) | sometimes | ✗ | -25° = 3.8 bars (asymmetric power boost), 0° = baseline, +25° = no contact (abort). Not curve. |
| **D-pad presses** | unknown | ✗ (currently) | Aim-arrow control mechanic — not working in our setup despite correct Dolphin bindings (open issue, below). |

---

## Specific working values (production calibration starting point)

A clean starting point for `BallSpeed → motion params`:

```
TrackMan BallSpeed → backAmp:
  30 m/s  → 50°    (~2.5 bars, ~150 yd)
  50 m/s  → 75°    (~3.0 bars, ~190 yd)
  77 m/s  → 115°   (4.0 bars, ~290 yd — PGA tour driver avg)
  100 m/s → 115°   (capped — ball speed beyond tour avg saturates anyway)

Hold constant: follow=30, pause=200, peakG=5, impactAxis=z,
               cursor pinned at 960,540
```

Numbers above need a final round of calibration once everything is wired up — but this is the playable range.

---

## What didn't work (catalogued so we don't try again)

- **Compound-scaling all parameters by `speedRatio`.** Caused either oversaturation (red-line slice) or aborts depending on how aggressive the scale. Single-lever isolation is the answer.

- **Bigger backswing past ~130°.** Triggers the game's "swing detected" detector mid-backswing, partially commits the swing at low bar fill, then continues our motion as just-animation while the ball has already left. Visual symptom: short backswing → backswing → downswing → no follow-through swing.

- **Capping centripetal acceleration at 2.5g** to avoid false-impact reads at high power. Did nothing — centripetal isn't read as impact, the abort threshold is on backswing peak omega (which is set by ampBack and backswingMs, not centripetal).

- **Phase-shifting swing motion** so theta=0 outputs `(0, 0, -1)` instead of `(0, +1, 0)` (matching the visual address pose). Made the swing weaker because the impact spike on +Z body axis ended up rotated to the wrong axis. Reverted.

- **Convention-rotating motion output** to `(ax, az, -ay)` after computing in old convention. Same problem as phase shift — moved the impact spike off the axis the game reads. Reverted.

- **Killing the follow-through phase to prevent low-power "tick up to 2 bars".** Reverted. Removing the follow-through dropped 77 m/s from 4 bars to 3 because the bar IS reading post-impact motion, just not quite enough to overshoot at high power.

- **Adding a settle phase** that smoothly decays theta back to 0 after follow-through. Made things worse than the rough discontinuity at swing end. Reverted.

- **Trying multiple DSU button-bit positions** (0x04, 0x05, 0xFF) for the A button. Never reliably worked. Spacebar weight on A is still required (see below).

- **Restarting Dolphin** to clear "IMU integrator drift" — turned out to be unnecessary because the actual issue was cursor position variance.

---

## Open issues / known caveats

### Rest-pose conflict (cosmetic)

- `(0, +1, 0)` — what the swing motion math is built around. Wiimote is "vertical, IR up" in this convention. Bar fill works correctly here.
- `(0, 0, -1)` — empirically gives the *visual* "Mii at address" pose in Dolphin (verified by setting rest manually).

These conflict. Currently we use `(0, +1, 0)` so the swing math works. The Mii's rest pose between shots looks slightly off but the swing fires correctly. **Not worth fixing for WS Golf** — purely cosmetic.

### Spacebar weight on A button still required

We did NOT successfully migrate to bridge-controlled A button presses. The DSU button approach (sending Cross/A bit in `buttons2`) doesn't reliably press A in Dolphin — same problem documented in the older `project_bridge_working_state.md` memory.

Current setup: physical weight (or whatever) holds Spacebar on the keyboard, which Dolphin reads as Wiimote A. Bridge does NOT toggle A. The drawback: A is held continuously, which breaks D-pad aim (you can't change direction while A is held). This is the root cause of the next issue.

We have helper code in `inject.mjs` (`pressKey`/`releaseKey` via PowerShell `keybd_event`) that COULD control Space programmatically, but it's not currently wired into the swing flow because we wanted to test in practice-swing mode first.

### D-pad direction control is currently broken

- Dolphin Wiimote D-pad bindings: confirmed correct, bound to `DSUClient/0/Pad N/E/W/S`. Verified by binding being saved and keyboard D-pad no longer working.
- Bridge sends D-pad bits in `buttons1` (byte 16 of DSU packet) — bit 0x10=Up, 0x20=Right, 0x40=Down, 0x80=Left.
- ALSO sends analog D-pad pressures in bytes 24–27 (0xFF when pressed).
- Result: nothing happens in-game. Heard a "button-not-bound" beep in some cases.

Possible causes (untested):
- "Pad N/E/W/S" in Dolphin might refer to face buttons, not D-pad, in this version
- The DSU byte layout for D-pad in this Dolphin build differs from the cemuhook spec
- Some other DSU field controls D-pad input
- A button being held continuously (spacebar weight) blocks D-pad regardless of how we send it

Path forward: probably needs a Dolphin source-code or DolphinDSUClient.cpp inspection to confirm exact D-pad protocol expectations, OR migrating off DSU for buttons (use SendInput/keybd_event for keyboard-bound D-pad keys).

---

## Pivoting to WSR Golf (next phase of project)

WSR Golf has full hook/slice/draw/fade physics — that's where curve actually exists. Approach:

1. **Run the same test infrastructure** (`bridge-test.mjs` + `inject.mjs raw …`) against WSR Golf. The DSU side will be identical; the wiimote IS the same wiimote. Any differences are in how WSR Golf reads the swing.

2. **Apply the single-lever sweep methodology verbatim** to find:
   - Power lever (probably backAmp or similar, but verify)
   - Direction lever (this is the prize — hook/slice in WSR Golf)
   - Aim lever (D-pad, IR pointer, or something else)

3. **Don't assume WS Golf findings transfer.** WSR Golf uses MotionPlus, which means it reads gyro data. Things that didn't matter in WS Golf (gyro intensity, swing-axis specifics) might be primary levers in WSR Golf.

4. **Pin the cursor first.** Same lesson — eliminate the IR pointer as a variable before testing motion params.

5. **Memory:** see `project_wsr_motionplus_deadend.md` and `project_wsr_memory_addresses.md` for previous WSR Golf attempts (motion-detection fuzzing failed, pivoted toward memory-poke approach). With the new methodology, motion-detection-via-empirical-sweeps is worth retrying before committing to memory-poke.

---

## File / branch state

- Branch: `test-curve` on `https://github.com/KezLahd/Wii-Golf-x-Trackman`
- `bridge-test.mjs` — main test bridge, has the swing motion + HTTP endpoints (`/inject`, `/inject-raw`, `/aim`, `/rest-pose`, `/state`)
- `inject.mjs` — CLI driver with `raw`, `aim`, sweep modes + cursor/keyboard helpers
- `bridge.mjs` — original v1 working bridge on `main`. NOT modified during this session. Use as fallback if `bridge-test.mjs` gets broken.
- `rest-pose.mjs` — small CLI to set neutral pose for rest-pose experiments

---

## One-liners reference

```
# Restart test bridge (no TrackMan required)
set USE_TRACKMAN=false && node bridge-test.mjs

# Fire raw shot with default everything (baseline)
node inject.mjs raw --delay 3

# Fire calibrated driver shot
node inject.mjs raw --backAmp 115 --follow 30 --peakG 5 --delay 3

# Aim test (BROKEN currently, see open issue)
node inject.mjs aim left 500 --delay 3
```
