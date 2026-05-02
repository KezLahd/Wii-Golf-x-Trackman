// bridge-test.mjs — curve experimentation rig.
//
// Sibling to bridge.mjs. Differences:
//   - Listens on DSU port 26761 (NOT the working bridge's 26760).
//   - HTTP control endpoint on localhost:8088 — POST /inject with a JSON
//     {BallSpeed, LaunchAngle, LaunchDirection} fires a synthetic swing
//     without needing TrackMan or a real ball.
//   - Adds X-axis accel + gyro bias during the impact window, scaled by
//     LaunchDirection (deg). This is the curve-control experiment — original
//     WS Golf reads accel only, so X tilt at impact should produce hook/slice.
//   - Optionally still subscribes to TrackMan if the radar is reachable.
//     Set USE_TRACKMAN=false to run injector-only (no radar dependency).
//
// Usage:
//   node bridge-test.mjs                    (with TrackMan attached)
//   USE_TRACKMAN=false node bridge-test.mjs (injector-only, no radar)
// Then, in another terminal:
//   node inject.mjs 50 12 -10               (BallSpeed=50, Launch=12°, Dir=-10° L)

import WebSocket from "ws";
import dgram from "node:dgram";
import http from "node:http";
import fs from "node:fs";

// ─── Config ────────────────────────────────────────────────────────────────
const RADAR = "192.168.0.9";
const DSU_PORT = 26761;            // separate port from prod bridge (26760)
const HTTP_PORT = 8088;
const SERVER_ID = 0xdeadbeef;
const SHOT_LOG = "C:/Users/TrackMan 4 Sim/tm-dolphin-bridge/shots-test.jsonl";
const TICK_HZ = 60;
const USE_TRACKMAN = process.env.USE_TRACKMAN !== "false";

// Swing curve tuning (copied from bridge.mjs — keep in sync as we tune)
const BACKSWING_MS       = 1200;
const PAUSE_MS           = 200;
const DOWNSWING_MS       = 600;
const FOLLOWTHRU_MS      = 400;
const BACK_AMP_DEG       = 160;
const FOLLOW_AMP_DEG     = 30;
const PEAK_G_PER_MS      = 0.15;
const MAX_PEAK_G         = 10.0;
const GYRO_INTENSITY_LO  = 1.40;
const GYRO_INTENSITY_HI  = 1.80;

// ─── Curve tuning (NEW — under test) ──────────────────────────────────────
// Original WS Golf has NO MotionPlus / no gyro — only accel + IR. So the
// curve mechanism must be a sustained X-axis component throughout the
// downswing, not a gyro twist or an impact-instant spike.
//
// Approach: rotate the swing-plane gravity around the forward (Z) axis by
// an angle proportional to LaunchDirection. This makes the wiimote behave
// as if held tilted through the entire swing, which is what produces
// hook/slice in WS Golf.
//
// CURVE_GAIN scales the max tilt angle. Raise to make a given
// LaunchDirection produce more pronounced curve in-game.
const CURVE_GAIN       = parseFloat(process.env.CURVE_GAIN ?? "1.0");
const MAX_DIR_DEG      = 20;                          // clip LaunchDirection at ±20°
const MAX_TILT_DEG     = 25 * CURVE_GAIN;             // max swing-plane tilt at ±MAX_DIR_DEG
const MAX_TILT_RAD     = MAX_TILT_DEG * Math.PI / 180;

// ─── Per-club scaling table ────────────────────────────────────────────────
// `speedTarget` = BallSpeed (m/s) at which the in-game power bar should hit
// full (4 bars). Anchored on PGA Tour averages so a tour-pro shot maxes the
// bar without red-lining.
const CLUB_TABLE = {
  driver: { speedTarget: 77 },   // tour avg ball speed
  iron:   { speedTarget: 56 },   // 7-iron tour avg
  wedge:  { speedTarget: 45 },   // PW tour avg
  putter: { speedTarget: 8  },   // arbitrary; putts are slow regardless
};

console.log(`[cfg] CURVE_GAIN=${CURVE_GAIN}  MAX_TILT=${MAX_TILT_DEG.toFixed(1)}° at LaunchDirection=±${MAX_DIR_DEG}°`);
console.log(`[cfg] club targets: driver=${CLUB_TABLE.driver.speedTarget} iron=${CLUB_TABLE.iron.speedTarget} wedge=${CLUB_TABLE.wedge.speedTarget} putter=${CLUB_TABLE.putter.speedTarget} (m/s ball speed → 4 bars)`);

// ─── DSU protocol (identical to bridge.mjs) ───────────────────────────────
const MSG_VERSION = 0x100000, MSG_INFO = 0x100001, MSG_DATA = 0x100002;
let packetCounter = 0;
const subscribers = new Map();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}
function buildServerPacket(messageType, payload) {
  const header = Buffer.alloc(16);
  header.write("DSUS", 0, "ascii");
  header.writeUInt16LE(1001, 4);
  header.writeUInt16LE(payload.length + 4, 6);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(SERVER_ID, 12);
  const msgTypeBuf = Buffer.alloc(4);
  msgTypeBuf.writeUInt32LE(messageType, 0);
  const full = Buffer.concat([header, msgTypeBuf, payload]);
  full.writeUInt32LE(crc32(full), 8);
  return full;
}
function slotInfoPayload(slot, connected) {
  const p = Buffer.alloc(12);
  p.writeUInt8(slot, 0);
  p.writeUInt8(connected ? 2 : 0, 1);
  p.writeUInt8(2, 2);
  p.writeUInt8(1, 3);
  Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]).copy(p, 4);
  p.writeUInt8(connected ? 5 : 0, 10);
  p.writeUInt8(0, 11);
  return p;
}
function buildControllerInfo(slot, connected) {
  return buildServerPacket(MSG_INFO, slotInfoPayload(slot, connected));
}
function buildDataPayload(slot, accel, gyro, buttons2 = 0) {
  const p = Buffer.alloc(80);
  slotInfoPayload(slot, true).copy(p, 0, 0, 11);
  p.writeUInt8(1, 11);
  p.writeUInt32LE(++packetCounter, 12);
  p.writeUInt8(buttons1, 16);
  p.writeUInt8(buttons2, 17);
  p.writeUInt8(128, 20); p.writeUInt8(128, 21);
  p.writeUInt8(128, 22); p.writeUInt8(128, 23);
  // Analog DPad pressures (bytes 24-27) — Dolphin's DSU client reads these
  // for D-pad input, not the bit flags in byte 16 alone.
  // 24 = Pad N (Up), 25 = Pad E (Right), 26 = Pad S (Down), 27 = Pad W (Left)
  if (buttons1 & 0x10) p.writeUInt8(0xff, 24);
  if (buttons1 & 0x20) p.writeUInt8(0xff, 25);
  if (buttons1 & 0x40) p.writeUInt8(0xff, 26);
  if (buttons1 & 0x80) p.writeUInt8(0xff, 27);
  if (buttons2 & 0x01) p.writeUInt8(0xff, 28);
  if (buttons2 & 0x02) p.writeUInt8(0xff, 29);
  if (buttons2 & 0x04) p.writeUInt8(0xff, 30);
  if (buttons2 & 0x08) p.writeUInt8(0xff, 31);
  p.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 48);
  p.writeFloatLE(accel.x, 56);
  p.writeFloatLE(-accel.y, 60);
  p.writeFloatLE(accel.z, 64);
  p.writeFloatLE(gyro.pitch, 68);
  p.writeFloatLE(gyro.yaw, 72);
  p.writeFloatLE(gyro.roll, 76);
  return p;
}
function buildDataPacket(slot, accel, gyro, buttons2) {
  return buildServerPacket(MSG_DATA, buildDataPayload(slot, accel, gyro, buttons2));
}

// ─── Rest pose (overridable via POST /rest-pose) ──────────────────────────
// Default (0, +1, 0) — matches the swing motion's theta=0 pose so there's
// no discontinuity at swing start/end.
let restPose = { x: 0, y: 1, z: 0 };

// D-pad state — for WS Golf aim arrow control. POST /aim sets this for
// a duration, then it clears. Bits per cemuhook DSU spec: 0x10=Up,
// 0x20=Right, 0x40=Down, 0x80=Left.
let buttons1 = 0;

// ─── Swing state machine ───────────────────────────────────────────────────
let swing = null;

function triggerSwing(shot, source = "trackman") {
  // Reject if a swing is still in flight — otherwise the new swing
  // replaces the old one mid-motion and the wiimote pose hard-jumps.
  if (swing !== null) {
    console.log(`[swing] rejected — already swinging (${swing.source})`);
    return false;
  }

  const profile = {
    kind: "full",
    backswingMs:  BACKSWING_MS,
    pauseMs:      PAUSE_MS,
    downswingMs:  DOWNSWING_MS,
    followthruMs: FOLLOWTHRU_MS,
    backAmpDeg:   BACK_AMP_DEG,
    followAmpDeg: FOLLOW_AMP_DEG,
    peakGPerMs:   PEAK_G_PER_MS,
    gyroLo:       GYRO_INTENSITY_LO,
    gyroHi:       GYRO_INTENSITY_HI,
    maxPeakG:     MAX_PEAK_G,
  };

  const club = (shot.Club ?? "driver").toLowerCase();
  const target = (CLUB_TABLE[club] ?? CLUB_TABLE.driver).speedTarget;

  // Two-tier scaling. powerRatio drives follow-through + impact — runs
  // wide-open up to 1.50 so 100 m/s shots hit much harder than 77 m/s.
  // ampRatio drives backswing depth — capped at 1.00 because past that
  // the game aborts mid-backswing. Lower floor (0.25) widens the low
  // end too: 30 m/s now sends a much smaller backswing than 77.
  const rawRatio = Math.max(0, Math.min(1.05, shot.BallSpeed / target));
  const speedRatio = 0.40 + 0.60 * rawRatio;
  profile.backAmpDeg   *= speedRatio;
  profile.followAmpDeg *= speedRatio;

  const peakG = Math.min(profile.maxPeakG, shot.BallSpeed * profile.peakGPerMs);

  const dirDeg  = Math.max(-MAX_DIR_DEG, Math.min(MAX_DIR_DEG, shot.LaunchDirection ?? 0));
  const dirNorm = dirDeg / MAX_DIR_DEG;
  const tiltRad = dirNorm * MAX_TILT_RAD;     // signed swing-plane tilt

  swing = {
    startedAt: Date.now(),
    peakG,
    tiltRad,
    speedRatio,
    ballSpeed: shot.BallSpeed,
    club,
    profile,
    source,
  };
  console.log(`[swing] (${source}) club=${club} BallSpeed=${shot.BallSpeed.toFixed(1)}m/s ratio=${speedRatio.toFixed(2)} backAmp=${profile.backAmpDeg.toFixed(0)}° followAmp=${profile.followAmpDeg.toFixed(0)}° peakG=${peakG.toFixed(2)}`);
  return true;
}

function motion() {
  const neutral = {
    accel: { x: restPose.x, y: restPose.y, z: restPose.z },
    gyro:  { pitch: 0, yaw: 0, roll: 0 },
    buttons2: 0,
  };
  if (!swing) return neutral;

  const p = swing.profile;
  const totalMs = p.backswingMs + p.pauseMs + p.downswingMs + p.followthruMs;
  const tMs = Date.now() - swing.startedAt;
  if (tMs >= totalMs) { swing = null; return neutral; }

  const tBackEnd  = p.backswingMs;
  const tPauseEnd = tBackEnd + p.pauseMs;
  const tDownEnd  = tPauseEnd + p.downswingMs;
  const ampBack   = p.backAmpDeg   * Math.PI / 180;
  const ampFollow = p.followAmpDeg * Math.PI / 180;

  let theta, omega;
  let phase;
  if (tMs < tBackEnd) {
    phase = "back";
    const u = tMs / p.backswingMs;
    const durSec = p.backswingMs / 1000;
    theta = -ampBack * (1 - Math.cos(Math.PI * u)) / 2;
    omega = -ampBack * (Math.PI / (2 * durSec)) * Math.sin(Math.PI * u);
  } else if (tMs < tPauseEnd) {
    phase = "pause";
    theta = -ampBack;
    omega = 0;
  } else if (tMs < tDownEnd) {
    phase = "down";
    const u = (tMs - tPauseEnd) / p.downswingMs;
    const durSec = p.downswingMs / 1000;
    theta = -ampBack * (1 + Math.cos(Math.PI * u)) / 2;
    omega =  ampBack * (Math.PI / (2 * durSec)) * Math.sin(Math.PI * u);
  } else {
    phase = "follow";
    const u = (tMs - tDownEnd) / p.followthruMs;
    const durSec = p.followthruMs / 1000;
    theta = ampFollow * (1 - Math.cos(Math.PI * u)) / 2;
    omega = ampFollow * (Math.PI / (2 * durSec)) * Math.sin(Math.PI * u);
  }

  let ax = 0;
  let ay = Math.cos(theta);
  let az = Math.sin(theta);

  const HAND_RADIUS_M = 2.5;
  const G = 9.81;
  const CENTRIPETAL_GAIN = 2.5 * Math.max(0.5, swing.speedRatio);
  const centripetalG = CENTRIPETAL_GAIN * (omega * omega * HAND_RADIUS_M) / G;
  ay += centripetalG;

  // Impact transient. Default = forward Z spike + slight downward Y yank.
  // For sweep E (impact axis testing), swing.impactAxis can override to
  // route the spike to Y or X instead.
  const impactWidthMs = swing.impactWidthMs ?? 35;
  const dtMs = tMs - tDownEnd;
  if (Math.abs(dtMs) < impactWidthMs) {
    const shape = Math.pow(Math.cos((Math.PI / 2) * (dtMs / impactWidthMs)), 2);
    const axis = swing.impactAxis ?? 'z';
    if (axis === 'z') {
      az += swing.peakG * shape;
      ay -= swing.peakG * 0.25 * shape;
    } else if (axis === 'y') {
      ay += swing.peakG * shape;
    } else if (axis === 'x') {
      ax += swing.peakG * shape;
    }
  }

  // ─── CURVE: rotate (ax, ay) around Z by tiltRad through downswing+impact ─
  // Original WS Golf reads accel only — so the wiimote needs a SUSTAINED
  // lateral component, not an impact-instant spike. Rotating the swing-plane
  // accel pair around the forward axis simulates the wiimote being held
  // tilted left/right throughout the swing, which is what produces hook/slice.
  // No tilt during back/pause phases (still a square setup), only ramps in
  // for the downswing+impact+follow-through.
  if (phase === "down" || phase === "follow") {
    const a = swing.tiltRad;
    const c = Math.cos(a), s = Math.sin(a);
    const axNew = ax * c - ay * s;
    const ayNew = ax * s + ay * c;
    ax = axNew; ay = ayNew;
  }

  // Pitch gyro is included for any DSU consumer that reads it — original WS
  // Golf ignores it (no MotionPlus), but harmless to send.
  const intensityScale = p.gyroLo + (p.gyroHi - p.gyroLo) * (swing.peakG / p.maxPeakG);
  const gyroVal = omega * (180 / Math.PI) * intensityScale;

  return {
    accel: { x: ax, y: ay, z: az },
    gyro:  { pitch: gyroVal, yaw: 0, roll: 0 },
    buttons2: 0x04 | 0x20,
  };
}

// ─── DSU UDP server ────────────────────────────────────────────────────────
const sock = dgram.createSocket("udp4");
const seenSubs = new Set();
sock.on("message", (msg, rinfo) => {
  if (msg.length < 20 || msg.toString("ascii", 0, 4) !== "DSUC") return;
  const msgType = msg.readUInt32LE(16);
  const key = `${rinfo.address}:${rinfo.port}`;
  switch (msgType) {
    case MSG_VERSION: {
      const out = Buffer.alloc(4); out.writeUInt16LE(1001, 0);
      sock.send(buildServerPacket(MSG_VERSION, out), rinfo.port, rinfo.address); break;
    }
    case MSG_INFO: {
      const portCount = msg.readInt32LE(20);
      for (let i = 0; i < portCount; i++) {
        const slot = msg.readUInt8(24 + i);
        if (slot < 4) sock.send(buildControllerInfo(slot, slot === 0), rinfo.port, rinfo.address);
      }
      break;
    }
    case MSG_DATA: {
      const slot = msg.readUInt8(21);
      subscribers.set(key, { slot, addr: rinfo.address, port: rinfo.port, ts: Date.now() });
      if (!seenSubs.has(key)) { seenSubs.add(key); console.log(`[dsu] subscriber ${key} slot=${slot}`); }
      break;
    }
  }
});
sock.on("listening", () => console.log(`[dsu] listening on 0.0.0.0:${DSU_PORT}`));
sock.bind(DSU_PORT, "0.0.0.0");

setInterval(() => {
  const now = Date.now();
  const { accel, gyro, buttons2 } = motion();
  for (const [key, sub] of subscribers) {
    if (now - sub.ts > 5000) { subscribers.delete(key); continue; }
    sock.send(buildDataPacket(sub.slot, accel, gyro, buttons2), sub.port, sub.addr);
  }
}, 1000 / TICK_HZ);

// ─── HTTP injection endpoint ──────────────────────────────────────────────
const shotLog = fs.createWriteStream(SHOT_LOG, { flags: "a" });
http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/inject") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const shot = JSON.parse(body);
        if (typeof shot.BallSpeed !== "number") throw new Error("BallSpeed required");
        shot.LaunchAngle ??= 12;
        shot.LaunchDirection ??= 0;
        triggerSwing(shot, "inject");
        shotLog.write(JSON.stringify({ ts: Date.now(), source: "inject", ...shot }) + "\n");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, fired: shot }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ swinging: !!swing, swing, restPose }));
    return;
  }
  if (req.method === "POST" && req.url === "/inject-raw") {
    // Bypasses ALL per-shot scaling. Caller specifies every motion knob
    // directly so we can isolate which one drives the bar.
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        if (swing !== null) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "swing in flight" }));
          return;
        }
        const r = JSON.parse(body);
        const profile = {
          kind:         "raw",
          backswingMs:  r.backMs   ?? 1200,
          pauseMs:      r.pause    ?? 200,
          downswingMs:  r.downMs   ?? 600,
          followthruMs: r.followMs ?? 400,
          backAmpDeg:   r.backAmp  ?? 100,
          followAmpDeg: r.follow   ?? 30,
          gyroLo:       1.40,
          gyroHi:       1.80,
          maxPeakG:     20,        // raised so peakG isn't capped during sweep D
          peakGPerMs:   0,
        };
        swing = {
          startedAt:      Date.now(),
          peakG:          r.peakG ?? 5,
          // tiltDeg in degrees (signed; negative=L, positive=R). Rotates
          // the (ax,ay) accel pair around Z by this angle through downswing
          // + follow phases — simulates the wiimote being held tilted
          // sideways through the swing (real-WSGolf hook/slice mechanic).
          tiltRad:        ((r.tiltDeg ?? 0) * Math.PI) / 180,
          // speedRatio drives the centripetal multiplier inside motion().
          // CENTRIPETAL_GAIN = 2.5 * max(0.5, speedRatio). Default 1.0 here
          // so raw mode gets the same gain as a tour-avg shot, unless caller
          // overrides via centripetalSpeedRatio.
          speedRatio:     r.centripetalSpeedRatio ?? 1.0,
          ballSpeed:      0,
          club:           "raw",
          profile,
          source:         "inject-raw",
          impactAxis:     r.impactAxis ?? "z",
          impactWidthMs:  r.impactWidthMs,
        };
        console.log(`[swing] (raw) backAmp=${profile.backAmpDeg}° pause=${profile.pauseMs}ms follow=${profile.followAmpDeg}° peakG=${swing.peakG}g axis=${swing.impactAxis} backMs=${profile.backswingMs} downMs=${profile.downswingMs} followMs=${profile.followthruMs}`);
        shotLog.write(JSON.stringify({ ts: Date.now(), source: "inject-raw", ...r }) + "\n");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, fired: { profile, peakG: swing.peakG, impactAxis: swing.impactAxis } }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/aim") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const r = JSON.parse(body);
        const bits = { up: 0x10, right: 0x20, down: 0x40, left: 0x80 };
        const bit = bits[r.dir];
        if (!bit) throw new Error("dir must be up/down/left/right");
        const durationMs = Number.isFinite(r.durationMs) ? r.durationMs : 500;
        buttons1 = bit;
        console.log(`[aim] holding ${r.dir} (bit 0x${bit.toString(16)}) for ${durationMs}ms`);
        setTimeout(() => {
          buttons1 = 0;
          console.log(`[aim] released`);
        }, durationMs);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, dir: r.dir, durationMs }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/rest-pose") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        if (p.reset) {
          restPose = { x: 0, y: 1, z: 0 };
        } else {
          if ([p.x, p.y, p.z].some(v => typeof v !== "number")) {
            throw new Error("x, y, z must be numbers");
          }
          restPose = { x: p.x, y: p.y, z: p.z };
        }
        console.log(`[rest] restPose = (${restPose.x}, ${restPose.y}, ${restPose.z})`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, restPose }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`[http] listening on 127.0.0.1:${HTTP_PORT}  (POST /inject, POST /inject-raw, GET /state, POST /rest-pose)`);
});

// ─── TrackMan side (optional) ─────────────────────────────────────────────
async function login() {
  const body = new URLSearchParams({ username: "Admin", action: "Force" });
  const res = await fetch(`http://${RADAR}/auth/login`, {
    method: "POST", body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
  const m = (res.headers.get("set-cookie") ?? "").match(/session_id=([^;]+)/);
  if (!m) throw new Error(`no session cookie (status ${res.status})`);
  return m[1];
}
async function rest(method, path, cookie, body) {
  return fetch(`http://${RADAR}${path}`, {
    method,
    headers: { "content-type": "application/json", Cookie: `session_id=${cookie}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const triggeredIds = new Set();

async function startTrackmanBridge() {
  const session = await login();
  console.log("[tm] authenticated as Admin");

  setInterval(async () => { try { await rest("POST", "/api/ValidateSession", session); } catch {} }, 10_000);
  setInterval(async () => { await rest("POST", "/api/Setup", session, { IsMeasuring: true }); }, 45_000);

  const ws = new WebSocket(`ws://${RADAR}/ws`, { headers: { Cookie: `session_id=${session}` } });

  ws.on("open", async () => {
    ws.send(JSON.stringify({ Type: "Subscribe", Payload: { MessageList: ["ALL"] } }));
    await new Promise((r) => setTimeout(r, 300));
    await rest("POST", "/api/Setup", session, { IsMeasuring: true });
    console.log("[tm] subscribed + radar armed.\n");
  });

  ws.on("message", (data) => {
    let parsed; try { parsed = JSON.parse(data.toString()); } catch { return; }
    if (parsed.Type === "Ping") { ws.send(JSON.stringify({ Type: "Pong", Payload: null })); return; }
    if (parsed.Type === "Measurement" && parsed.Payload?.BallSpeed !== undefined) {
      const id = parsed.Payload.Id;
      if (id && !triggeredIds.has(id)) {
        triggeredIds.add(id);
        triggerSwing(parsed.Payload, "trackman");
        shotLog.write(JSON.stringify({ ts: Date.now(), source: "trackman", ...parsed.Payload }) + "\n");
        if (triggeredIds.size > 200) {
          const old = [...triggeredIds].slice(0, 100);
          old.forEach(x => triggeredIds.delete(x));
        }
      }
    }
  });
  ws.on("error", (err) => console.error("[ws error]", err.message));
  ws.on("close", (code) => console.log(`[ws closed] code=${code}`));
}

if (USE_TRACKMAN) {
  startTrackmanBridge().catch((err) => { console.error("[tm] disabled —", err.message); });
} else {
  console.log("[tm] disabled via USE_TRACKMAN=false (injector-only mode)");
}
