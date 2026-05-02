import WebSocket from "ws";
import dgram from "node:dgram";
import fs from "node:fs";

// ─── Config ────────────────────────────────────────────────────────────────
const RADAR = "192.168.0.9";
const DSU_PORT = 26760;
const SERVER_ID = 0xdeadbeef;
const SHOT_LOG = "C:/Users/TrackMan 4 Sim/tm-dolphin-bridge/shots.jsonl";
const TICK_HZ = 60;

// Swing curve tuning
//
// Calibrated against Dolphin source + real-Wiimote swing measurements:
//   - Dolphin's MotionPlus.cpp hard-clamps gyro at ±2259 deg/s. Exceeding
//     produces a flat-topped waveform with LESS integrated angular
//     displacement than a sharper lower peak — this is why soft shots
//     were filling the power meter more than hard ones.
//   - Real WSR Golf drives peak 1200–1800 deg/s on the dominant axis.
//   - Real impact accel spike is only 3–5g on the forward axis (the
//     Wiimote isn't physically hit — it's just the sudden wrist-deceleration
//     at the bottom of the arc). 20g+ is unrealistic and may be rejected.
//   - Real swings have an explicit ~100–150ms pause at top of backswing.
// Full-swing profile — restored timing that committed swings successfully
// (1.2s backswing, 0.2s pause, 0.6s downswing). Boosting only BACK_AMP_DEG
// from the original 140° to 180° so the meter fills higher without
// changing the motion shape the detector accepts.
const BACKSWING_MS       = 1200;
const PAUSE_MS           = 200;
const DOWNSWING_MS       = 600;
const FOLLOWTHRU_MS      = 400;
const BACK_AMP_DEG       = 180;   // boosted from 140 — bigger backswing = more meter
const FOLLOW_AMP_DEG     = 35;
// Working-state impact magnitudes (don't make these aggressive — over-tuning
// caused commit failures).
const PEAK_G_PER_MS      = 0.15;
const MAX_PEAK_G         = 10.0;
const GYRO_INTENSITY_LO  = 1.40;
const GYRO_INTENSITY_HI  = 1.80;

// Putt profile — separate config because a putt is a short pendulum, not
// a windup-and-fire swing. Wii Sports Golf reads it differently and a full
// swing on the putter just nudges the ball a few cm regardless of intensity,
// since the putter clubface is heavily damped.
//
// A putt detection threshold of BallSpeed < 5 m/s catches almost all real
// putts (real putts are 0.5-5 m/s). Chips/pitches with slightly higher speed
// fall through to the full-swing profile, which is correct.
// Putt/chip profile — covers everything BallSpeed<15. Stronger than a pure
// putt because chips (5-15 m/s) need enough motion signal to commit.
const PUTT_BACKSWING_MS  = 550;
const PUTT_PAUSE_MS      = 130;
const PUTT_DOWNSWING_MS  = 380;
const PUTT_FOLLOWTHRU_MS = 250;
const PUTT_BACK_AMP_DEG  = 100;
const PUTT_FOLLOW_AMP_DEG = 25;
const PUTT_PEAK_G_PER_MS = 0.30;  // 13 m/s chip → 3.9g, 5 m/s putt → 1.5g
const PUTT_GYRO_INTENSITY = 1.50;
// PUTT_BALLSPEED_MAX = 0 disables the putt/chip profile — every shot uses
// the full-swing profile. The putt profile reliably broke chip/putt
// commits (game's detector wouldn't accept the smaller motion). Accept
// over-powered putts in exchange for every shot actually firing — same
// behavior as the April 18 working state.
const PUTT_BALLSPEED_MAX = 0.0;

const DEBUG_IMPACT_LOG   = true;  // print the actual accel/gyro at impact

// ─── DSU protocol ──────────────────────────────────────────────────────────
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
// DSU controller data payload is exactly 80 bytes. Layout per cemuhook spec:
//   [0..11) slot info (slot,state,model,conn,MAC,battery,pad)
//   [11]    isConnected
//   [12..16)packet number
//   [16..18)buttons1+buttons2
//   [18]    PS btn   [19] touch btn
//   [20..24)sticks  [24..28) analog dpad  [28..36) analog buttons
//   [36..42)touch1  [42..48) touch2
//   [48..56)motion timestamp (us)
//   [56..68)accel XYZ (float32)
//   [68..80)gyro pitch/yaw/roll (float32)
function buildDataPayload(slot, accel, gyro, buttons2 = 0) {
  const p = Buffer.alloc(80);
  // slot info minus the 12th terminator byte
  slotInfoPayload(slot, true).copy(p, 0, 0, 11);
  p.writeUInt8(1, 11);                                    // isConnected
  p.writeUInt32LE(++packetCounter, 12);
  p.writeUInt8(0, 16);                                    // buttons1 (dpad/start/select)
  p.writeUInt8(buttons2, 17);                             // buttons2 (bits: Sq,Cr,Ci,Tr,R1,L1,R2,L2)
  // Sticks centred (DSU convention: byte 128 = neutral). A buffer full of
  // zeros tells Dolphin "both sticks jammed fully down-left", which can
  // crosstalk into Wiimote bindings and caused Motion Simulation inputs to
  // fire phantom left/right during swings.
  p.writeUInt8(128, 20); p.writeUInt8(128, 21);           // left stick X/Y
  p.writeUInt8(128, 22); p.writeUInt8(128, 23);           // right stick X/Y
  // Also set the analog-pressure version of the button so DSU consumers
  // that read analog rather than digital still see the press.
  // byte 28 Sq, 29 Cr, 30 Ci, 31 Tr, 32 R1, 33 L1, 34 R2, 35 L2
  if (buttons2 & 0x01) p.writeUInt8(0xff, 28);
  if (buttons2 & 0x02) p.writeUInt8(0xff, 29);
  if (buttons2 & 0x04) p.writeUInt8(0xff, 30);
  if (buttons2 & 0x08) p.writeUInt8(0xff, 31);
  p.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 48);
  // Wiimote accel convention: held vertical with IR up (address position) reads
  // (0, -1, 0). Our motion() internally treats +Y = up for sanity; flip here so
  // the wire-level signal matches what Dolphin/WSR Golf expect.
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

// ─── Swing state machine ───────────────────────────────────────────────────
let swing = null; // { startedAt, peakG, direction, profile }

function triggerSwing(shot) {
  const isPutt = shot.BallSpeed < PUTT_BALLSPEED_MAX;
  const profile = isPutt
    ? {
        kind: "putt",
        backswingMs:  PUTT_BACKSWING_MS,
        pauseMs:      PUTT_PAUSE_MS,
        downswingMs:  PUTT_DOWNSWING_MS,
        followthruMs: PUTT_FOLLOWTHRU_MS,
        backAmpDeg:   PUTT_BACK_AMP_DEG,
        followAmpDeg: PUTT_FOLLOW_AMP_DEG,
        peakGPerMs:   PUTT_PEAK_G_PER_MS,
        gyroLo:       PUTT_GYRO_INTENSITY,
        gyroHi:       PUTT_GYRO_INTENSITY,
        maxPeakG:     2.0,
      }
    : {
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

  const peakG = Math.min(profile.maxPeakG, shot.BallSpeed * profile.peakGPerMs);

  // Scale backswing amplitude by BallSpeed: drives use full 180° windup,
  // chips half of that, putts a tiny pendulum. Three tiers because a single
  // floor either over-powers chips or fails to commit putts.
  // Drive (60+) → 1.0 (180° back); wedge (35) → 0.58; chip (10) → 0.40;
  // putt (1-3) → 0.20 (36° back, light tap).
  let ampScale;
  if (shot.BallSpeed < 4.0) {
    ampScale = 0.25; // putt range
  } else if (shot.BallSpeed < 15.0) {
    // Linear ramp from 0.45 (5 m/s = soft chip) up to 0.70 (15 m/s = strong chip)
    ampScale = 0.45 + 0.025 * (shot.BallSpeed - 5.0);
  } else {
    ampScale = Math.max(0.50, Math.min(1.0, shot.BallSpeed / 60));
  }
  if (!isPutt) {
    profile.backAmpDeg   *= ampScale;
    profile.followAmpDeg *= ampScale;
  }

  swing = {
    startedAt: Date.now(),
    peakG,
    direction: shot.LaunchDirection ?? 0,  // deg, negative=L positive=R
    ballSpeed: shot.BallSpeed,
    profile,
  };
  console.log(`[swing] triggered  kind=${profile.kind}  BallSpeed=${shot.BallSpeed.toFixed(1)}m/s peakG=${peakG.toFixed(2)}  ampScale=${ampScale.toFixed(2)}`);
}

// Returns current accel + gyro for the active swing, or neutral rest.
//
// Curve design (WSR Golf MotionPlus-friendly):
//   - One continuous smooth arc, NO hold at top of backswing.
//   - θ(t) is C¹-smooth so the gyro signal (dθ/dt) is continuous.
//   - Roll-gyro magnitude PEAKS at impact, matching how a real swing reads on
//     MotionPlus — WSR Golf's swing detector keys on this peak.
//   - Impact accel spike (+Z) is centred on the same instant as the gyro peak.
function motion() {
  const neutral = {
    accel: { x: 0, y: 1, z: 0 },
    gyro: { pitch: 0, yaw: 0, roll: 0 },
    buttons2: 0,
  };
  if (!swing) return neutral;

  const p = swing.profile;
  const totalMs = p.backswingMs + p.pauseMs + p.downswingMs + p.followthruMs;
  const tMs = Date.now() - swing.startedAt;
  if (tMs >= totalMs) {
    if (DEBUG_IMPACT_LOG && swing.observedPeakGyro !== undefined) {
      console.log(`[swing] ended    peakGyro=${swing.observedPeakGyro.toFixed(0)}deg/s  peakZ=${swing.observedPeakAz.toFixed(2)}g`);
    }
    swing = null;
    return neutral;
  }

  // Four-phase swing matching real-Wiimote golf swings:
  //   backswing → pause at top → downswing → follow-through
  const tBackEnd  = p.backswingMs;
  const tPauseEnd = tBackEnd + p.pauseMs;
  const tDownEnd  = tPauseEnd + p.downswingMs;  // impact instant
  const ampBack   = p.backAmpDeg   * Math.PI / 180;
  const ampFollow = p.followAmpDeg * Math.PI / 180;

  let theta, omega;  // omega = dθ/dt in rad/s
  if (tMs < tBackEnd) {
    // Backswing: smooth ramp 0 → −ampBack (peak gyro mid-phase)
    const u = tMs / p.backswingMs;
    const durSec = p.backswingMs / 1000;
    theta = -ampBack * (1 - Math.cos(Math.PI * u)) / 2;
    omega = -ampBack * (Math.PI / (2 * durSec)) * Math.sin(Math.PI * u);
  } else if (tMs < tPauseEnd) {
    // Pause at top — gyro returns to zero, theta held at −ampBack.
    theta = -ampBack;
    omega = 0;
  } else if (tMs < tDownEnd) {
    // Downswing: −ampBack → 0. Symmetric sin profile.
    const u = (tMs - tPauseEnd) / p.downswingMs;
    const durSec = p.downswingMs / 1000;
    theta = -ampBack * (1 + Math.cos(Math.PI * u)) / 2;
    omega =  ampBack * (Math.PI / (2 * durSec)) * Math.sin(Math.PI * u);
  } else {
    // Follow-through: 0 → +ampFollow, gyro decays
    const u = (tMs - tDownEnd) / p.followthruMs;
    const durSec = p.followthruMs / 1000;
    theta = ampFollow * (1 - Math.cos(Math.PI * u)) / 2;
    omega = ampFollow * (Math.PI / (2 * durSec)) * Math.sin(Math.PI * u);
  }

  // Gravity in Wiimote local frame, rotated in Y–Z plane.
  let ay = Math.cos(theta);
  let az = Math.sin(theta);

  // Motion-induced accel from swing rotation (ω² × R). Wii Sports Golf's
  // swing meter scales heavily off this. The gain is BallSpeed-proportional
  // so a wedge gets a softer centripetal than a driver — without this,
  // tuning that maxed out the driver/iron oversaturated the wedge detector
  // and the swing wouldn't register at all.
  const HAND_RADIUS_M = 2.5;
  const G = 9.81;
  // BallSpeed scaling. Floor of 0.5 so chips/putts still get enough
  // motion signal to commit; was 0.25 which made 7-13 m/s shots only-backswing.
  const speedGain = Math.max(0.50, Math.min(1.0, swing.ballSpeed / 70));
  const CENTRIPETAL_GAIN = 2.5 * speedGain;
  const centripetalG =
      CENTRIPETAL_GAIN * (omega * omega * HAND_RADIUS_M) / G;
  // Centripetal pulls along +Y (toward the shaft / wrist) when held vertical.
  ay += centripetalG;

  // Impact transient — narrow +Z accel spike at end of downswing (impact
  // instant = tDownEnd).
  const impactWidthMs = 35;
  const dtMs = tMs - tDownEnd;
  if (Math.abs(dtMs) < impactWidthMs) {
    const shape = Math.pow(Math.cos((Math.PI / 2) * (dtMs / impactWidthMs)), 2);
    az += swing.peakG * shape;
    ay -= swing.peakG * 0.25 * shape;
  }

  // Gyro scales with shot intensity so a hard shot rotates faster. Range
  // is tuned to clear MotionPlus's slow-mode ceiling (440 deg/s) on every
  // shot and land in fast mode (up to 2000 deg/s), which is what WSR Golf
  // keys on to register a real swing.
  //
  // Axis: for a vertical Wiimote hold (address position) the golf-swing
  // rotation is around the Wiimote's X axis = PITCH. (Earlier test with
  // pitch at only 400 deg/s peak showed a faint pulse because the signal
  // never cleared slow-mode threshold; retrying now that we reliably hit
  // 1200+ deg/s. Roll was making the game read our motion as clubface
  // twist, producing the left-right power-bar oscillation.)
  const intensityScale = p.gyroLo +
    (p.gyroHi - p.gyroLo) * (swing.peakG / p.maxPeakG);
  const gyroVal = omega * (180 / Math.PI) * intensityScale;

  if (DEBUG_IMPACT_LOG) {
    const gMag = Math.abs(gyroVal);
    if (swing.observedPeakGyro === undefined || gMag > swing.observedPeakGyro) swing.observedPeakGyro = gMag;
    if (swing.observedPeakAz === undefined  || az > swing.observedPeakAz)  swing.observedPeakAz  = az;
  }

  // Original Wii Sports Golf doesn't use MotionPlus, so gyro is largely
  // irrelevant — the accel pattern alone drives swing detection. Keep yaw=0
  // and roll=0; the phase-split yaw was a WSR-specific tweak that broke this
  // game's detector.
  return {
    accel: { x: 0, y: ay, z: az },
    gyro: {
      pitch: gyroVal,
      yaw:   0,
      roll:  0,
    },
    buttons2: 0x04 | 0x20, // Cross/A bits (avoid B = gravity recalibrate)
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

// ─── TrackMan side ─────────────────────────────────────────────────────────
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
  const shotLog = fs.createWriteStream(SHOT_LOG, { flags: "a" });
  const session = await login();
  console.log("[tm] authenticated as Admin");

  setInterval(async () => { try { await rest("POST", "/api/ValidateSession", session); } catch {} }, 10_000);
  setInterval(async () => { await rest("POST", "/api/Setup", session, { IsMeasuring: true }); }, 45_000);

  const ws = new WebSocket(`ws://${RADAR}/ws`, { headers: { Cookie: `session_id=${session}` } });

  ws.on("open", async () => {
    ws.send(JSON.stringify({ Type: "Subscribe", Payload: { MessageList: ["ALL"] } }));
    await new Promise((r) => setTimeout(r, 300));
    await rest("POST", "/api/Setup", session, { IsMeasuring: true });
    console.log("[tm] subscribed + radar armed. Ready — hit a ball.\n");
  });

  ws.on("message", (data) => {
    let parsed; try { parsed = JSON.parse(data.toString()); } catch { return; }
    if (parsed.Type === "Ping") { ws.send(JSON.stringify({ Type: "Pong", Payload: null })); return; }
    if (parsed.Type === "TrackerState" && parsed.Payload?.TrackerState && parsed.Payload.TrackerState !== "Idle") {
      process.stdout.write(`  → ${parsed.Payload.TrackerState}\n`);
    }
    if (parsed.Type === "Measurement" && parsed.Payload?.BallSpeed !== undefined) {
      // Radar emits multiple Measurement messages per shot (PreLaunchData,
      // LaunchData, FlightData, Measurement). For full-flight shots we get
      // all four; for soft putts the radar may stop after FlightData and
      // never send the final Kind="Measurement", so we previously missed
      // those entirely. Fire on the FIRST message of any Kind for a shot,
      // dedupe by Id.
      const id = parsed.Payload.Id;
      if (id && !triggeredIds.has(id)) {
        triggeredIds.add(id);
        triggerSwing(parsed.Payload);
        shotLog.write(JSON.stringify(parsed.Payload) + "\n");
        // Bound the set so it doesn't grow unbounded over a long session.
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

startTrackmanBridge().catch((err) => { console.error("fatal:", err); process.exit(1); });
