// Dolphin emulated-memory accessor.
//
// Opens Dolphin.exe via ReadProcessMemory/WriteProcessMemory (memoryjs),
// locates the host-address region that backs Wii MEM1 (game 0x80000000..),
// and exposes read/write helpers keyed on game-virtual addresses.
//
// MEM1 discovery: enumerate committed RW regions, find one large enough to
// hold MEM1 (24 MiB) or the MEM1+MEM2 arena (88 MiB on Wii), and validate by
// reading a known static pointer (spSimBall @ 0x806F54E8) — if the u32 there
// falls back into MEM1 range, the region's base IS game 0x80000000 in host.
//
// Matches the algorithm dolphin-memory-engine uses
// (Source/DolphinProcess/Windows/WindowsDolphinProcess.cpp).

import memoryjs from "memoryjs";

const MEM1_BASE_GAME = 0x80000000;
const MEM1_END_GAME  = 0x81800000; // 24 MiB
const MEM2_END_GAME  = 0x94000000; // Wii MEM2 top (not used here, but for range check)

// The static pointer we use as a sentinel during MEM1 discovery. Any pointer
// inside a populated RPGlfBall-bearing struct is fine; this one is stable
// whenever WSR Golf is loaded past the title screen.
const SENTINEL_GAME_ADDR = 0x806F54E8;

let proc = null;
let mem1HostBase = null; // host address where game 0x80000000 lives

function gameToHost(gameAddr) {
  if (mem1HostBase === null) throw new Error("dolphin-mem: not attached");
  if (gameAddr < MEM1_BASE_GAME || gameAddr >= MEM2_END_GAME) {
    throw new Error(`dolphin-mem: game addr 0x${gameAddr.toString(16)} out of range`);
  }
  return mem1HostBase + (gameAddr - MEM1_BASE_GAME);
}

function isPlausibleGamePointer(val) {
  return val >= MEM1_BASE_GAME && val < MEM1_END_GAME;
}

export function attach() {
  proc = memoryjs.openProcess("Dolphin.exe");
  if (!proc) throw new Error("dolphin-mem: Dolphin.exe not running");

  // Candidate region sizes Dolphin allocates for its MEM arena, in preference
  // order. Modern Dolphin uses a 0x400000000 (16 GiB) reserved fastmem arena
  // on 64-bit — we'd never match that by size alone, so we fall back to a
  // sentinel-validation pass over every committed RW region.
  const regions = memoryjs.getRegions(proc.handle);

  for (const r of regions) {
    // Skip non-committed or non-writable regions
    if (r.State !== 0x1000) continue;        // MEM_COMMIT
    if (!(r.Protect & 0x04 || r.Protect & 0x40)) continue; // PAGE_READWRITE | PAGE_EXECUTE_READWRITE
    if (r.RegionSize < 0x1800000) continue;  // must hold 24 MiB MEM1

    // Validate: treat this region's base as game 0x80000000 and try to read
    // the sentinel pointer. If it dereferences to something plausibly inside
    // MEM1, we've found it.
    const testHost = r.BaseAddress + (SENTINEL_GAME_ADDR - MEM1_BASE_GAME);
    let sentinelVal;
    try {
      sentinelVal = memoryjs.readMemory(proc.handle, testHost, memoryjs.UINT32);
    } catch {
      continue;
    }
    if (isPlausibleGamePointer(sentinelVal)) {
      mem1HostBase = r.BaseAddress;
      console.log(`[mem] attached. MEM1 host base = 0x${mem1HostBase.toString(16)}, ` +
                  `sentinel [0x${SENTINEL_GAME_ADDR.toString(16)}] = 0x${sentinelVal.toString(16)}`);
      return;
    }
  }
  throw new Error("dolphin-mem: no MEM1 region located. Is a game loaded past the title screen?");
}

export function readU32(gameAddr) {
  // Wii is big-endian in game memory. memoryjs reads in host (little-endian)
  // byte order, so swap.
  const raw = memoryjs.readMemory(proc.handle, gameToHost(gameAddr), memoryjs.UINT32);
  return ((raw & 0xff) << 24) | ((raw & 0xff00) << 8) |
         ((raw >>> 8) & 0xff00) | ((raw >>> 24) & 0xff);
}

export function readFloat(gameAddr) {
  // Read 4 bytes, swap, reinterpret as float.
  const buf = Buffer.alloc(4);
  const raw = memoryjs.readMemory(proc.handle, gameToHost(gameAddr), memoryjs.UINT32);
  buf.writeUInt32BE(raw >>> 0, 0);
  return buf.readFloatLE(0); // already swapped by BE-write+LE-read
}

export function writeFloat(gameAddr, value) {
  // Write big-endian: swap then writeUInt32
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value, 0);
  const swapped = buf.readUInt32BE(0);
  memoryjs.writeMemory(proc.handle, gameToHost(gameAddr), swapped, memoryjs.UINT32);
}

export function writeU32(gameAddr, value) {
  const raw = ((value & 0xff) << 24) | ((value & 0xff00) << 8) |
              ((value >>> 8) & 0xff00) | ((value >>> 24) & 0xff);
  memoryjs.writeMemory(proc.handle, gameToHost(gameAddr), raw >>> 0, memoryjs.UINT32);
}

export function writeByte(gameAddr, value) {
  memoryjs.writeMemory(proc.handle, gameToHost(gameAddr), value & 0xff, memoryjs.UINT8);
}

export function readByte(gameAddr) {
  return memoryjs.readMemory(proc.handle, gameToHost(gameAddr), memoryjs.UINT8);
}
