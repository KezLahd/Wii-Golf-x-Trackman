// inject.mjs — fire a synthetic shot at bridge-test.mjs.
//
// Usage:
//   node inject.mjs <BallSpeed> [LaunchAngle] [LaunchDirection] [Club] [--delay N]
// Club is one of: driver, iron, wedge, putter (default: driver).
// --delay N waits N seconds before firing — gives you time to click back
// into Dolphin so the game has focus when the shot lands.
//
// Examples:
//   node inject.mjs 77 12 0 driver --delay 3      tour-avg driver, 3s delay
//   node inject.mjs 56 16 0 iron --delay 3        tour-avg 7-iron
//
// Sweep helpers:
//   node inject.mjs sweep-dir [Club]              dir sweep at tour-avg
//   node inject.mjs sweep-power [Club]            BallSpeed sweep at dir=0
//
// RAW mode (diagnostic — bypasses all per-shot scaling, drive each motion
// parameter directly. Use to figure out which lever the game's bar fill
// actually responds to.):
//   node inject.mjs raw [--backAmp N] [--pause N] [--follow N] [--peakG N]
//                       [--backMs N] [--downMs N] [--followMs N]
//                       [--impactAxis z|y|x] [--impactWidthMs N]
//                       [--centripetalSpeedRatio N] [--delay N]
// Defaults (the "baseline"): backAmp=100°, pause=200ms, follow=30°, peakG=5g,
// backMs=1200, downMs=600, followMs=400, impactAxis=z. Vary ONE flag at a time
// to isolate what moves the bar.
// Example sweep A (pause sweep):
//   node inject.mjs raw --pause 50 --delay 3
//   node inject.mjs raw --pause 300 --delay 3
//   node inject.mjs raw --pause 800 --delay 3
//   node inject.mjs raw --pause 1500 --delay 3
//   node inject.mjs raw --pause 3000 --delay 3

import { exec, spawn } from "node:child_process";

const URL = "http://127.0.0.1:8088/inject";
const URL_RAW = "http://127.0.0.1:8088/inject-raw";

const TOUR_AVG = { driver: 77, iron: 56, wedge: 45, putter: 6 };

// VK_SPACE — the keycode for Space (= Wiimote A in Dolphin's default profile).
const VK_SPACE = 0x20;

// Move the Windows mouse cursor to a fixed screen position. Uses PowerShell
// + System.Windows.Forms — no extra deps required.
function setCursor(x, y) {
  return new Promise((resolve, reject) => {
    const cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x|0}, ${y|0})"`;
    exec(cmd, (err) => err ? reject(err) : resolve());
  });
}

// Press or release a Win32 virtual-key. Uses spawn (no shell escaping) +
// PowerShell + user32.keybd_event so the press is real OS input — Dolphin
// reads it as if you'd hit the key on the keyboard. Lets us control the A
// button (Space) without a physical weight on the keyboard.
function keybdEvent(vk, isUp) {
  const flags = isUp ? 2 : 0;
  const psScript = `Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, uint extra);'; [W.K]::keybd_event(${vk}, 0, ${flags}, 0)`;
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell", ["-NoProfile", "-Command", psScript]);
    ps.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`keybdEvent exit ${code}`)));
  });
}
const pressKey   = (vk) => keybdEvent(vk, false);
const releaseKey = (vk) => keybdEvent(vk, true);

// Always release A on script exit so a crash mid-swing can't leave Space
// stuck pressed.
const releaseAOnExit = () => { keybdEvent(VK_SPACE, true).catch(() => {}); };
process.on("exit", releaseAOnExit);
process.on("SIGINT", () => { releaseAOnExit(); process.exit(1); });
process.on("uncaughtException", (e) => { console.error(e); releaseAOnExit(); process.exit(1); });

async function fireRaw(body) {
  const res = await fetch(URL_RAW, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log(`raw → ${JSON.stringify(body)}  ${res.status} ${JSON.stringify(data)}`);
}

async function fireAim(dir, durationMs) {
  const res = await fetch("http://127.0.0.1:8088/aim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dir, durationMs }),
  });
  const data = await res.json();
  console.log(`aim → ${dir} ${durationMs}ms  ${res.status} ${JSON.stringify(data)}`);
}

async function fire(BallSpeed, LaunchAngle, LaunchDirection, Club) {
  const body = JSON.stringify({ BallSpeed, LaunchAngle, LaunchDirection, Club });
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const data = await res.json();
  console.log(`→ ${Club.padEnd(6)} ${BallSpeed.toFixed(1).padStart(5)}m/s  ${LaunchAngle.toFixed(1).padStart(5)}°  dir=${LaunchDirection.toFixed(1).padStart(6)}°  ${res.status} ${JSON.stringify(data)}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sweepDir(club) {
  const speed = TOUR_AVG[club] ?? 77;
  const dirs = [-15, -10, -5, 0, 5, 10, 15];
  console.log(`# sweep-dir for ${club} at ${speed} m/s tour-avg ball speed`);
  for (const d of dirs) {
    await fire(speed, 12, d, club);
    await sleep(6000);
  }
}

async function sweepPower(club) {
  const target = TOUR_AVG[club] ?? 77;
  const speeds = [0.3, 0.5, 0.7, 0.9, 1.0, 1.1].map(r => +(r * target).toFixed(1));
  console.log(`# sweep-power for ${club} (target=${target} m/s)`);
  for (const s of speeds) {
    await fire(s, 12, 0, club);
    await sleep(6000);
  }
}

// Parse all --flag VALUE pairs out of argv into `flags`, leaving positional
// arguments in `positional`.
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    flags[argv[i].slice(2)] = argv[i + 1];
    i++;
  } else {
    positional.push(argv[i]);
  }
}

let delaySec = 0;
if (flags.delay !== undefined) {
  delaySec = parseFloat(flags.delay);
  if (isNaN(delaySec) || delaySec < 0) {
    console.error("--delay needs a non-negative number of seconds");
    process.exit(1);
  }
}

// Cursor target — defaults to screen center (960,540 for 1080p). The
// cursor is ONLY moved right before fire (after the countdown). User
// clicks their own spot on the ball during setup, cursor jumps to the
// calibration point at the last moment. Pass --cursor 0,0 to skip.
const cursorSpec = flags.cursor ?? "960,540";
let cursorXY = null;
if (cursorSpec !== "0,0") {
  const [cx, cy] = cursorSpec.split(",").map(s => parseInt(s.trim(), 10));
  if (Number.isFinite(cx) && Number.isFinite(cy)) {
    cursorXY = [cx, cy];
  }
}

async function withDelay(fn) {
  if (delaySec > 0) {
    for (let s = Math.ceil(delaySec); s > 0; s--) {
      console.log(`firing in ${s}... click into Dolphin now`);
      await sleep(1000);
    }
  }
  // Re-lock cursor right before firing in case it drifted during setup.
  if (cursorXY) {
    await setCursor(cursorXY[0], cursorXY[1]);
  }
  try {
    await fn();
  } catch (err) {
    console.error("[error]", err.message);
    process.exit(1);
  }
}

const args = positional;
if (args[0] === "aim") {
  // node inject.mjs aim <left|right|up|down> [durationMs]
  const dir = (args[1] ?? "left").toLowerCase();
  if (!["up", "down", "left", "right"].includes(dir)) {
    console.error("aim direction must be up, down, left, or right");
    process.exit(1);
  }
  const durationMs = parseInt(args[2] ?? "500", 10);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    console.error("durationMs must be a positive integer");
    process.exit(1);
  }
  await withDelay(() => fireAim(dir, durationMs));
} else if (args[0] === "raw") {
  // Build raw motion body from --flag overrides. Anything unset uses the
  // bridge's defaults (backAmp=100, pause=200, follow=30, peakG=5, backMs=1200,
  // downMs=600, followMs=400, impactAxis=z, impactWidthMs=35).
  const body = {};
  const numFlags = ["backAmp", "pause", "follow", "peakG", "backMs", "downMs", "followMs", "impactWidthMs", "centripetalSpeedRatio", "tiltDeg"];
  for (const f of numFlags) {
    if (flags[f] !== undefined) {
      const v = parseFloat(flags[f]);
      if (isNaN(v)) { console.error(`--${f} requires a number`); process.exit(1); }
      body[f] = v;
    }
  }
  if (flags.impactAxis !== undefined) {
    if (!["z", "y", "x"].includes(flags.impactAxis)) {
      console.error("--impactAxis must be z, y, or x");
      process.exit(1);
    }
    body.impactAxis = flags.impactAxis;
  }
  await withDelay(() => fireRaw(body));
} else if (args[0] === "sweep-dir") {
  const club = (args[1] ?? "driver").toLowerCase();
  await withDelay(() => sweepDir(club));
} else if (args[0] === "sweep-power") {
  const club = (args[1] ?? "driver").toLowerCase();
  await withDelay(() => sweepPower(club));
} else {
  const BallSpeed       = parseFloat(args[0] ?? "50");
  const LaunchAngle     = parseFloat(args[1] ?? "12");
  const LaunchDirection = parseFloat(args[2] ?? "0");
  const Club            = (args[3] ?? "driver").toLowerCase();
  if (isNaN(BallSpeed)) {
    console.error("usage: node inject.mjs <BallSpeed> [LaunchAngle] [LaunchDirection] [Club] [--delay N]");
    console.error("    or node inject.mjs raw [--backAmp N --pause N --follow N --peakG N ...] [--delay N]");
    process.exit(1);
  }
  await withDelay(() => fire(BallSpeed, LaunchAngle, LaunchDirection, Club));
}
