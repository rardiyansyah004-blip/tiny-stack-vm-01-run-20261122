// Tiny stack VM for make.fun's tiny-stack-vm-01 ISA. Reads /input/i001..i040,
// writes /output/<id>/stdout.bin + exit.txt. Roots via MAKEFUN_INPUT_DIR /
// MAKEFUN_OUTPUT_DIR (defaults /input, /output). Deterministic: no clock,
// randomness, or network.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

// Opcodes 00-07, 10-1E, 20-22, 30-34, 40-41, 50-53; immediates: PUSH8 1,
// PUSH32 4, JMP/JZ/JNZ/CALL 2, else 0. Jumps use signed 16-bit offsets.
// Limits: 1e6 steps, 256 stack values, 64 returns, 256 memory words, 65536 out bytes.

// Binary ops (a b -- r); division by zero traps 4, checked by the caller.
const BIN = {
  0x10: (a, b) => (a + b) | 0, 0x11: (a, b) => (a - b) | 0, 0x12: (a, b) => Math.imul(a, b),
  0x13: (a, b) => (a / b) | 0, 0x14: (a, b) => a % b, // DIV/MOD: INT_MIN/-1 wraps, x%-1 is 0
  0x15: (a, b) => Math.trunc((a >>> 0) / (b >>> 0)) | 0, 0x16: (a, b) => ((a >>> 0) % (b >>> 0)) | 0,
  0x18: (a, b) => a & b, 0x19: (a, b) => a | b, 0x1a: (a, b) => a ^ b,
  0x1c: (a, b) => a << (b & 31), 0x1d: (a, b) => a >> (b & 31), 0x1e: (a, b) => (a >>> (b & 31)) | 0,
  0x20: (a, b) => (a === b ? 1 : 0), 0x21: (a, b) => (a < b ? 1 : 0),
  0x22: (a, b) => ((a >>> 0) < (b >>> 0) ? 1 : 0), // LTU, unsigned
};

// Run one program; returns [output bytes, exit code]. A trap ends the run
// at once with the trap's code; output written before the trap is kept.
function run(p: Uint8Array, inp: Uint8Array) {
  const mem = new Int32Array(256);
  const st = new Int32Array(257);
  const ret = new Int32Array(64);
  let out = ""; // output bytes as a latin1 string; converted at the end
  let sp = 0, rp = 0, pc = 0, ip = 0, steps = 0, code = 0; // stack/call ptrs, input ptr, steps, exit code

  // An instruction's stack needs, checked before it runs: too few to pop
  // traps 2 (underflow); pushing past 256 values traps 3 (overflow).
  const need = (a: number, b: number) => {
    if (sp < a) throw 2;
    if (sp - a + b > 256) throw 3;
  };

  try {
    for (;;) {
      if (steps >= 1e6) throw 10;
      if (pc < 0 || pc >= p.length) throw 9;
      const op = p[pc];
      if (!(op <= 7 || (op >= 16 && op <= 30) || (op >= 32 && op <= 34) ||
        (op >= 48 && op <= 52) || (op >= 64 && op <= 65) || (op >= 80 && op <= 83))) throw 5;
      const n = op === 1 ? 1 : op === 2 ? 4 : op >= 48 && op <= 51 ? 2 : 0;
      if (pc + 1 + n > p.length) throw 9;
      steps++;
      const next = pc + 1 + n; // address of the next instruction
      switch (op) {
        case 0x00: // HALT
          return [Buffer.from(out, "latin1"), 0];
        case 0x01: // PUSH8: byte as a signed 8-bit value
          need(0, 1);
          st[sp++] = p[pc + 1] < 128 ? p[pc + 1] : p[pc + 1] - 256;
          pc = next;
          break;
        case 0x02: // PUSH32: four bytes, little-endian, signed
          need(0, 1);
          st[sp++] = p[pc + 1] | (p[pc + 2] << 8) | (p[pc + 3] << 16) | (p[pc + 4] << 24);
          pc = next;
          break;
        case 0x03: need(1, 0); sp--; pc = next; break; // POP
        case 0x04: need(1, 2); st[sp] = st[sp - 1]; sp++; pc = next; break; // DUP
        case 0x05: // SWAP
          need(2, 2);
          [st[sp - 1], st[sp - 2]] = [st[sp - 2], st[sp - 1]];
          pc = next;
          break;
        case 0x06: need(2, 3); st[sp] = st[sp - 2]; sp++; pc = next; break; // OVER
        case 0x07: // ROT: (a b c -- b c a)
          need(3, 3);
          [st[sp - 3], st[sp - 2], st[sp - 1]] = [st[sp - 2], st[sp - 1], st[sp - 3]];
          pc = next;
          break;
        case 0x10: case 0x11: case 0x12: case 0x13: case 0x14:
        case 0x15: case 0x16: case 0x18: case 0x19: case 0x1a:
        case 0x1c: case 0x1d: case 0x1e: case 0x20: case 0x21:
        case 0x22: { // binary op: (a b -- r)
          need(2, 1);
          const b = st[sp - 1];
          if (op >= 0x13 && op <= 0x16 && b === 0) throw 4;
          st[sp - 2] = BIN[op](st[sp - 2], b);
          sp--;
          pc = next;
          break;
        }
        case 0x17: need(1, 1); st[sp - 1] = (-st[sp - 1]) | 0; pc = next; break; // NEG, wraps
        case 0x1b: need(1, 1); st[sp - 1] = ~st[sp - 1]; pc = next; break; // NOT
        case 0x30: pc = next + (((p[pc + 1] | (p[pc + 2] << 8)) << 16) >> 16); break; // JMP
        case 0x31: need(1, 0); pc = st[--sp] === 0 ? next + (((p[pc + 1] | (p[pc + 2] << 8)) << 16) >> 16) : next; break; // JZ
        case 0x32: need(1, 0); pc = st[--sp] !== 0 ? next + (((p[pc + 1] | (p[pc + 2] << 8)) << 16) >> 16) : next; break; // JNZ
        case 0x33: if (rp >= 64) throw 7; ret[rp++] = next; pc = p[pc + 1] | (p[pc + 2] << 8); break; // CALL
        case 0x34: if (rp === 0) throw 8; pc = ret[--rp]; break; // RET
        case 0x40: need(1, 1); if (st[sp - 1] < 0 || st[sp - 1] > 255) throw 6; st[sp - 1] = mem[st[sp - 1]]; pc = next; break; // LOAD
        case 0x41: need(2, 0); if (st[sp - 1] < 0 || st[sp - 1] > 255) throw 6; mem[st[sp - 1]] = st[sp - 2]; sp -= 2; pc = next; break; // STORE
        case 0x50: { // PRINT: decimal ASCII, leading '-' when negative
          need(1, 0);
          const s = String(st[--sp]);
          if (out.length + s.length > 65536) throw 11;
          out += s;
          pc = next;
          break;
        }
        case 0x51: // PUTC: one byte, v AND 255
          need(1, 0);
          if (out.length + 1 > 65536) throw 11;
          out += String.fromCharCode(st[--sp] & 255);
          pc = next;
          break;
        case 0x52: // IN: next input byte, -1 once the input is used up
          need(0, 1);
          st[sp++] = ip < inp.length ? inp[ip++] : -1;
          pc = next;
          break;
        case 0x53: // EXIT: exit with v AND 255
          need(1, 0);
          return [Buffer.from(out, "latin1"), st[--sp] & 255];
        default:
          throw 5; // unreachable: known() already filtered opcodes
      }
    }
  } catch (e) {
    code = typeof e === "number" ? e : 9;
  }
  return [Buffer.from(out, "latin1"), code];
}

function read(p: string) {
  try { return readFileSync(p); } catch { return new Uint8Array(0); }
}

for (let k = 0; k < 40; k++) {
  const id = "i" + ("00" + (k + 1)).slice(-3);
  const [stdout, code] = run(
    read(join(IN_DIR, id, "program.bin")),
    read(join(IN_DIR, id, "input.bin")),
  );
  const dir = join(OUT_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout.bin"), stdout);
  writeFileSync(join(dir, "exit.txt"), code + "\n");
}
