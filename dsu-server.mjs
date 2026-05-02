import dgram from "node:dgram";
import crypto from "node:crypto";

// Minimal DSU / cemuhook motion server.
// Spec reference: https://v1993.github.io/cemuhook-protocol/
// Implements enough to get Dolphin to subscribe to slot 0 and consume
// accelerometer + gyro data. No buttons, no touch.

const PORT = 26760;
const SERVER_ID = 0xdeadbeef; // arbitrary 32-bit server identifier

const MSG_VERSION  = 0x100000;
const MSG_INFO     = 0x100001;
const MSG_DATA     = 0x100002;

let packetCounter = 0;
// Map of subscribers keyed by "ip:port" → { slot, ts, addr, port }
const subscribers = new Map();

function crc32(buf) {
  // Simple CRC32 (IEEE) — Node's zlib has it but easier to write inline
  // Actually node has crypto? No — use zlib.crc32 isn't stable across versions.
  // We'll use a small table-based implementation.
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function buildServerPacket(messageType, payload) {
  const header = Buffer.alloc(16);
  header.write("DSUS", 0, "ascii");
  header.writeUInt16LE(1001, 4);                           // protocol version
  header.writeUInt16LE(payload.length + 4, 6);             // data length = payload + msgType
  header.writeUInt32LE(0, 8);                              // CRC placeholder
  header.writeUInt32LE(SERVER_ID, 12);                     // server ID

  const msgTypeBuf = Buffer.alloc(4);
  msgTypeBuf.writeUInt32LE(messageType, 0);

  const full = Buffer.concat([header, msgTypeBuf, payload]);
  const crc = crc32(full);
  full.writeUInt32LE(crc, 8);
  return full;
}

// Slot info payload: 12 bytes
//   slot (1), state (1), model (1), connection (1),
//   MAC (6), battery (1), "0" terminator (1)
function slotInfoPayload(slot, connected) {
  const p = Buffer.alloc(12);
  p.writeUInt8(slot, 0);
  p.writeUInt8(connected ? 2 : 0, 1);   // state: 0=disconnected, 2=connected
  p.writeUInt8(2, 2);                    // model: 2 = full gyro
  p.writeUInt8(1, 3);                    // connection: 1 = USB
  // MAC address (6 bytes) — fake but consistent
  Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]).copy(p, 4);
  p.writeUInt8(connected ? 5 : 0, 10);   // battery: 5 = full
  p.writeUInt8(0, 11);                    // terminator
  return p;
}

function buildControllerInfo(slot, connected) {
  return buildServerPacket(MSG_INFO, slotInfoPayload(slot, connected));
}

// Controller data packet payload:
//   slot info (12 bytes, same as above)
//   isConnected (1)
//   packet number (4)
//   buttons1 (1) buttons2 (1) home (1) touch button (1)
//   left stick x/y (2)  right stick x/y (2)
//   analog buttons x 12 (12)
//   touch1: active(1) id(1) x(2) y(2)
//   touch2: active(1) id(1) x(2) y(2)
//   motion timestamp microseconds (8)
//   accel x/y/z float32 (12)
//   gyro  pitch/yaw/roll float32 (12)
function buildDataPayload(slot, accel, gyro) {
  const p = Buffer.alloc(12 + 1 + 4 + 4 + 4 + 12 + 12 + 12 + 8 + 12 + 12);
  let o = 0;
  slotInfoPayload(slot, true).copy(p, o); o += 12;
  p.writeUInt8(1, o); o += 1;               // isConnected
  p.writeUInt32LE(++packetCounter, o); o += 4;
  // buttons/sticks/analog all zero
  o += 4;   // buttons1, buttons2, home, touch button
  o += 4;   // left stick xy + right stick xy
  o += 12;  // analog buttons
  o += 12;  // touch1 (6) + touch2 (6)
  // motion timestamp (us since epoch, 8 bytes little-endian)
  const ts = BigInt(Date.now()) * 1000n;
  p.writeBigUInt64LE(ts, o); o += 8;
  // accel
  p.writeFloatLE(accel.x, o); o += 4;
  p.writeFloatLE(accel.y, o); o += 4;
  p.writeFloatLE(accel.z, o); o += 4;
  // gyro
  p.writeFloatLE(gyro.pitch, o); o += 4;
  p.writeFloatLE(gyro.yaw, o); o += 4;
  p.writeFloatLE(gyro.roll, o); o += 4;
  return p;
}

function buildDataPacket(slot, accel, gyro) {
  return buildServerPacket(MSG_DATA, buildDataPayload(slot, accel, gyro));
}

const sock = dgram.createSocket("udp4");

sock.on("message", (msg, rinfo) => {
  if (msg.length < 20) return;
  if (msg.toString("ascii", 0, 4) !== "DSUC") return;
  const msgType = msg.readUInt32LE(16);
  const key = `${rinfo.address}:${rinfo.port}`;

  switch (msgType) {
    case MSG_VERSION: {
      const out = Buffer.alloc(4);
      out.writeUInt16LE(1001, 0);
      sock.send(buildServerPacket(MSG_VERSION, out), rinfo.port, rinfo.address);
      break;
    }
    case MSG_INFO: {
      // Payload: # ports requested (4 bytes) + up to 4 port IDs
      const portCount = msg.readInt32LE(20);
      for (let i = 0; i < portCount; i++) {
        const slot = msg.readUInt8(24 + i);
        if (slot >= 4) continue;
        sock.send(buildControllerInfo(slot, slot === 0), rinfo.port, rinfo.address);
      }
      break;
    }
    case MSG_DATA: {
      // Payload: register flags (1) slot (1) MAC (6)
      const slot = msg.readUInt8(21);
      subscribers.set(key, { slot, addr: rinfo.address, port: rinfo.port, ts: Date.now() });
      if (!seenSubscribers.has(key)) {
        seenSubscribers.add(key);
        console.log(`[dsu] subscriber ${key} slot=${slot}`);
      }
      break;
    }
  }
});

const seenSubscribers = new Set();

sock.on("listening", () => {
  const a = sock.address();
  console.log(`[dsu] listening on ${a.address}:${a.port}`);
  console.log(`[dsu] start Dolphin / enable Wii Remote DSU client and you should see a subscriber appear.`);
});

sock.bind(PORT, "0.0.0.0");

// Send neutral motion at 60Hz to any active subscriber (drops expired ones)
setInterval(() => {
  const now = Date.now();
  for (const [key, sub] of subscribers) {
    if (now - sub.ts > 5000) { subscribers.delete(key); continue; }
    const pkt = buildDataPacket(sub.slot, { x: 0, y: 0, z: 1 }, { pitch: 0, yaw: 0, roll: 0 });
    sock.send(pkt, sub.port, sub.addr);
  }
}, 1000 / 60);
