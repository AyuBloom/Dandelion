import Bun from "bun";
import { fileURLToPath } from "node:url";
import { DandelionError, getErrorMessage } from "../shared/errors.ts";
import { logger } from "../shared/logger.ts";

type WasmExports = {
  g: WebAssembly.Memory;
  h: () => void;
  i: (argc: number, argv: number) => number;
  j: (field: number, size: number) => number;
  k: WebAssembly.Table;
  l: (size: number) => number;
  m: () => number;
  n: (ptr: number) => void;
  o: (size: number) => number;
  p?: (ptr: number) => void;
  free?: (ptr: number) => void;
  zombs_last_selector?: () => number;
  zombs_last_iterations?: () => number;
  zombs_last_found?: () => number;
};

export default class Solver {
  ipAddress: string;
  textDecoder: TextDecoder;
  memory!: WebAssembly.Memory;
  table!: WebAssembly.Table;

  HEAP8!: Int8Array;
  HEAP16!: Int16Array;
  HEAP32!: Int32Array;
  HEAPU8!: Uint8Array;
  HEAPU16!: Uint16Array;
  HEAPU32!: Uint32Array;
  HEAPF32!: Float32Array;
  HEAPF64!: Float64Array;

  ___wasm_call_ctors!: () => void;
  _main!: (argc: number, argv: number) => number;
  _MakeBlendField!: (field: number, size: number) => number;
  _malloc!: (size: number) => number;
  stackSave!: () => number;
  stackRestore!: (ptr: number) => void;
  stackAlloc!: (size: number) => number;
  _free!: (ptr: number) => void;
  zombsLastSelector?: () => number;
  zombsLastIterations?: () => number;
  zombsLastFound?: () => number;

  #scriptStringBufferPtr = 0;
  #scriptStringBufferSize = 0;

  constructor(ipAddress: string) {
    this.ipAddress = ipAddress;
    this.textDecoder = new TextDecoder("utf-8");
  }

  #abort(reason = ""): never {
    throw new DandelionError("SOLVER_INIT_FAILED", `WASM aborted: ${reason}`);
  }

  #emscriptenRunScriptString(_ptr: number): number {
    const result = this.ipAddress;
    if (result == null) return 0;

    const value = String(result);
    const byteLength = this.#lengthBytesUTF8(value);

    if (!this.#scriptStringBufferSize || this.#scriptStringBufferSize < byteLength + 1) {
      if (this.#scriptStringBufferSize) this._free(this.#scriptStringBufferPtr);
      this.#scriptStringBufferSize = byteLength + 1;
      this.#scriptStringBufferPtr = this._malloc(this.#scriptStringBufferSize);
    }

    this.#stringToUTF8(value, this.#scriptStringBufferPtr, this.#scriptStringBufferSize);
    return this.#scriptStringBufferPtr;
  }

  #emscriptenRunScriptInt(ptr: number): number {
    const script = this.#UTF8ToString(ptr);

    if (script.includes('typeof window === "undefined" ? 1 : 0')) return 0;
    if (script.includes("typeof process !== 'undefined' ? 1 : 0")) return 0;
    if (script.includes("Game.currentGame.network.connected")) return 1;
    if (script.includes("Game.currentGame.world.myUid")) return 0;
    if (script.includes('document.getElementById("hud").children.length')) return 24;

    return eval(script) | 0;
  }

  #emscriptenGetNow(): number {
    return performance.now();
  }

  #emscriptenResizeHeap(requestedSize: number): boolean {
    requestedSize >>>= 0;

    const maxHeapSize = 2147483648;
    if (requestedSize > maxHeapSize) return false;

    const oldSize = this.HEAPU8.length;
    for (let cutDown = 1; cutDown <= 4; cutDown *= 2) {
      let overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
      overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);

      const newSize = Math.min(
        maxHeapSize,
        this.#alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536),
      );

      if (this.#growMemory(newSize)) return true;
    }

    return false;
  }

  #emscriptenMemcpy(dest: number, src: number, num: number): number {
    this.HEAPU8.copyWithin(dest, src, src + num);
    return dest;
  }

  async init(): Promise<void> {
    const wasmPath = fileURLToPath(new URL("./zombs_wasm.wasm", import.meta.url));
    const wasmBinary = await Bun.file(wasmPath).arrayBuffer();
    const imports = {
      a: {
        a: (reason?: string) => this.#abort(reason),
        b: (ptr: number) => this.#emscriptenRunScriptString(ptr),
        c: (ptr: number) => this.#emscriptenRunScriptInt(ptr),
        d: () => this.#emscriptenGetNow(),
        e: (requestedSize: number) => this.#emscriptenResizeHeap(requestedSize),
        f: (dest: number, src: number, num: number) => this.#emscriptenMemcpy(dest, src, num),
      },
    };

    const module = await WebAssembly.instantiate(wasmBinary, imports);
    const exports = module.instance.exports as WasmExports;

    this.memory = exports.g;
    this.#updateMemoryViews(this.memory.buffer);
    this.table = exports.k;

    this.___wasm_call_ctors = exports.h;
    this._main = exports.i;
    this._MakeBlendField = exports.j;
    this._malloc = exports.l;
    this.stackSave = exports.m;
    this.stackRestore = exports.n;
    this.stackAlloc = exports.o;
    this._free = exports.p ?? exports.free ?? (() => {});
    this.zombsLastSelector = exports.zombs_last_selector;
    this.zombsLastIterations = exports.zombs_last_iterations;
    this.zombsLastFound = exports.zombs_last_found;

    this.#run();
  }

  #run(): void {
    this.___wasm_call_ctors();

    const args: string[] = [];
    const argc = args.length + 1;
    const argv = this.stackAlloc(4 * (argc + 1));

    this.HEAP32[argv >> 2] = this.#stringToUTF8OnStack("./this.program");
    for (let i = 1; i < argc; i++) {
      this.HEAP32[(argv >> 2) + i] = this.#stringToUTF8OnStack(args[i - 1]!);
    }
    this.HEAP32[(argv >> 2) + argc] = 0;

    try {
      this._main(argc, argv);
    } catch (error) {
      throw new DandelionError("SOLVER_INIT_FAILED", `WASM main failed: ${getErrorMessage(error)}`);
    }
  }

  #updateMemoryViews(buffer: ArrayBuffer): void {
    this.HEAP8 = new Int8Array(buffer);
    this.HEAP16 = new Int16Array(buffer);
    this.HEAP32 = new Int32Array(buffer);
    this.HEAPU8 = new Uint8Array(buffer);
    this.HEAPU16 = new Uint16Array(buffer);
    this.HEAPU32 = new Uint32Array(buffer);
    this.HEAPF32 = new Float32Array(buffer);
    this.HEAPF64 = new Float64Array(buffer);
  }

  #stringToUTF8OnStack(str: string): number {
    const size = this.#lengthBytesUTF8(str) + 1;
    const ret = this.stackAlloc(size);
    this.#stringToUTF8(str, ret, size);
    return ret;
  }

  #lengthBytesUTF8(str: string): number {
    let len = 0;

    for (let i = 0; i < str.length; ++i) {
      const code = str.charCodeAt(i);

      if (code <= 0x7f) {
        len++;
      } else if (code <= 0x7ff) {
        len += 2;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        len += 4;
        ++i;
      } else {
        len += 3;
      }
    }

    return len;
  }

  #stringToUTF8(str: string, outPtr: number, maxBytesToWrite: number): number {
    return this.#stringToUTF8Array(str, this.HEAPU8, outPtr, maxBytesToWrite);
  }

  #stringToUTF8Array(
    str: string,
    heap: Uint8Array | Int8Array,
    outIdx: number,
    maxBytesToWrite: number,
  ): number {
    if (!(maxBytesToWrite > 0)) return 0;

    const startIdx = outIdx;
    const endIdx = outIdx + maxBytesToWrite - 1;

    for (let i = 0; i < str.length; ++i) {
      let code = str.charCodeAt(i);

      if (code >= 0xd800 && code <= 0xdfff) {
        const lowSurrogate = str.charCodeAt(++i);
        code = 0x10000 + ((code & 0x3ff) << 10) + (lowSurrogate & 0x3ff);
      }

      if (code <= 0x7f) {
        if (outIdx >= endIdx) break;
        heap[outIdx++] = code;
      } else if (code <= 0x7ff) {
        if (outIdx + 1 >= endIdx) break;
        heap[outIdx++] = 0xc0 | (code >> 6);
        heap[outIdx++] = 0x80 | (code & 0x3f);
      } else if (code <= 0xffff) {
        if (outIdx + 2 >= endIdx) break;
        heap[outIdx++] = 0xe0 | (code >> 12);
        heap[outIdx++] = 0x80 | ((code >> 6) & 0x3f);
        heap[outIdx++] = 0x80 | (code & 0x3f);
      } else {
        if (outIdx + 3 >= endIdx) break;
        heap[outIdx++] = 0xf0 | (code >> 18);
        heap[outIdx++] = 0x80 | ((code >> 12) & 0x3f);
        heap[outIdx++] = 0x80 | ((code >> 6) & 0x3f);
        heap[outIdx++] = 0x80 | (code & 0x3f);
      }
    }

    heap[outIdx] = 0;
    return outIdx - startIdx;
  }

  #UTF8ToString(ptr: number, maxBytesToRead?: number): string {
    return ptr ? this.#UTF8ArrayToString(this.HEAPU8, ptr, maxBytesToRead) : "";
  }

  #UTF8ArrayToString(u8Array: Uint8Array, idx: number, maxBytesToRead = Infinity): string {
    const endIdx = idx + maxBytesToRead;
    let endPtr = idx;

    while (u8Array[endPtr] && !(endPtr >= endIdx)) {
      ++endPtr;
    }

    if (endPtr - idx > 16 && u8Array.subarray && this.textDecoder) {
      return this.textDecoder.decode(u8Array.subarray(idx, endPtr));
    }

    let str = "";
    while (idx < endPtr) {
      let byte = u8Array[idx++]!;

      if (byte & 0x80) {
        const byte1 = u8Array[idx++]! & 0x3f;
        if ((byte & 0xe0) !== 0xc0) {
          const byte2 = u8Array[idx++]! & 0x3f;
          byte =
            (byte & 0xf0) === 0xe0
              ? ((byte & 0x0f) << 12) | (byte1 << 6) | byte2
              : ((byte & 0x07) << 18) |
                (byte1 << 12) |
                (byte2 << 6) |
                (u8Array[idx++]! & 0x3f);

          if (byte < 0x10000) {
            str += String.fromCharCode(byte);
          } else {
            const ch = byte - 0x10000;
            str += String.fromCharCode(0xd800 | (ch >> 10), 0xdc00 | (ch & 0x3ff));
          }
        } else {
          str += String.fromCharCode(((byte & 0x1f) << 6) | byte1);
        }
      } else {
        str += String.fromCharCode(byte);
      }
    }

    return str;
  }

  #alignMemory(size: number, alignment: number): number {
    return size + ((alignment - (size % alignment)) % alignment);
  }

  #growMemory(size: number): 1 | undefined {
    try {
      this.memory.grow((size - this.memory.buffer.byteLength + 0xffff) >>> 16);
      this.#updateMemoryViews(this.memory.buffer);
      return 1;
    } catch (error) {
      logger.error(`WASM grow failed: ${getErrorMessage(error)}`);
    }
  }

  getDebugState(): Record<string, number> | undefined {
    if (!this.zombsLastSelector || !this.zombsLastIterations || !this.zombsLastFound) {
      return undefined;
    }

    return {
      selector: this.zombsLastSelector(),
      iterations: this.zombsLastIterations(),
      found: this.zombsLastFound(),
    };
  }
}
