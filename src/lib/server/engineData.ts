/**
 * Photoshop's EngineData syntax, as the document `Txt2` block uses it: `<< /key value >>`
 * dictionaries, `[ … ]` arrays, `/names`, integers, reals, booleans and `( … )` UTF-16BE
 * strings with `(`, `)` and `\` bytes escaped. Parsing then writing an unchanged value gives
 * Photoshop's bytes back exactly, so a template from a Photoshop file survives untouched
 * wherever it is not edited. (ag-psd's parser rejects the empty strings Photoshop writes there.)
 */
export type EValue =
  | { t: "dict"; e: [string, EValue][] }
  | { t: "array"; v: EValue[] }
  | { t: "int"; v: number }
  | { t: "real"; v: number; raw?: string }
  /** `latin1` marks the 8-bit strings Photoshop writes without a UTF-16 byte order mark. */
  | { t: "string"; v: string; latin1?: boolean }
  | { t: "name"; v: string }
  | { t: "bool"; v: boolean };

export const E = {
  dict: (e: [string, EValue][] = []): EValue => ({ t: "dict", e }),
  array: (v: EValue[]): EValue => ({ t: "array", v }),
  int: (v: number): EValue => ({ t: "int", v: Math.round(v) }),
  real: (v: number): EValue => ({ t: "real", v }),
  string: (v: string): EValue => ({ t: "string", v }),
  name: (v: string): EValue => ({ t: "name", v }),
  bool: (v: boolean): EValue => ({ t: "bool", v }),
};

export function get(v: EValue | undefined, ...path: string[]): EValue | undefined {
  let at = v;
  for (const key of path) {
    if (!at) return;
    if (at.t === "dict") at = at.e.find(([k]) => k === key)?.[1];
    else if (at.t === "array") at = at.v[Number(key)];
    else return;
  }
  return at;
}

/** Sets `key` on a dictionary, keeping its position when it already exists. */
export function set(dict: EValue | undefined, key: string, value: EValue) {
  if (dict?.t !== "dict") return;
  const at = dict.e.find(([k]) => k === key);
  if (at) at[1] = value;
  else dict.e.push([key, value]);
}

export const clone = (v: EValue): EValue => structuredClone(v);

const SPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const DELIM = new Set([0x20, 0x09, 0x0a, 0x0d, 0x5b, 0x5d, 0x3c, 0x3e, 0x28, 0x29, 0x2f]);

/** Parses the top level of a `Txt2` block: a dictionary's entries without the `<< >>`. */
export function parseEngineData(bytes: Uint8Array): EValue {
  let i = 0;
  const skip = () => {
    while (i < bytes.length && SPACE.has(bytes[i])) i++;
  };
  const word = () => {
    const start = i;
    while (i < bytes.length && !DELIM.has(bytes[i])) i++;
    return String.fromCharCode(...bytes.subarray(start, i));
  };
  const entries = (close: boolean): [string, EValue][] => {
    const out: [string, EValue][] = [];
    for (;;) {
      skip();
      if (i >= bytes.length) {
        if (close) throw new Error("EngineData: unterminated dictionary");
        return out;
      }
      if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) {
        if (!close) throw new Error("EngineData: unexpected >>");
        i += 2;
        return out;
      }
      if (bytes[i] !== 0x2f) throw new Error(`EngineData: expected a key at ${i}`);
      i++;
      out.push([word(), value()]);
    }
  };
  const value = (): EValue => {
    skip();
    const c = bytes[i];
    if (c === 0x3c && bytes[i + 1] === 0x3c) {
      i += 2;
      return { t: "dict", e: entries(true) };
    }
    if (c === 0x5b) {
      i++;
      const v: EValue[] = [];
      for (;;) {
        skip();
        if (bytes[i] === 0x5d) {
          i++;
          return { t: "array", v };
        }
        if (i >= bytes.length) throw new Error("EngineData: unterminated array");
        v.push(value());
      }
    }
    if (c === 0x28) {
      i++;
      const raw: number[] = [];
      while (i < bytes.length && bytes[i] !== 0x29) {
        if (bytes[i] === 0x5c) i++;
        raw.push(bytes[i++]);
      }
      i++;
      return raw[0] === 0xfe && raw[1] === 0xff
        ? { t: "string", v: decodeString(raw) }
        : { t: "string", v: String.fromCharCode(...raw), latin1: true };
    }
    if (c === 0x2f) {
      i++;
      return { t: "name", v: word() };
    }
    const w = word();
    if (w === "true" || w === "false") return { t: "bool", v: w === "true" };
    if (/^-?\d+$/.test(w)) return { t: "int", v: Number(w) };
    if (/^-?\d*\.\d*(e-?\d+)?$/i.test(w)) return { t: "real", v: Number(w), raw: w };
    throw new Error(`EngineData: unexpected token ${JSON.stringify(w)} at ${i}`);
  };
  return { t: "dict", e: entries(false) };
}

function decodeString(raw: number[]): string {
  if (raw[0] === 0xfe && raw[1] === 0xff) {
    let s = "";
    for (let k = 2; k + 1 < raw.length; k += 2) s += String.fromCharCode((raw[k] << 8) | raw[k + 1]);
    return s;
  }
  return String.fromCharCode(...raw);
}

/** Photoshop's real format: `1.0`, `.5`, `-52.12246`. */
export function formatReal(n: number): string {
  if (!Number.isFinite(n)) n = 0;
  if (Number.isInteger(n)) return `${n}.0`;
  let s = n.toFixed(5).replace(/0+$/, "");
  s = s.replace(/^(-?)0\./, "$1.");
  return s === "-." || s === "." ? "0.0" : s;
}

export function serializeEngineData(top: EValue): Uint8Array {
  const out: number[] = [];
  const ascii = (s: string) => {
    for (let k = 0; k < s.length; k++) out.push(s.charCodeAt(k));
  };
  const write = (v: EValue) => {
    switch (v.t) {
      case "dict":
        ascii("<<");
        for (const [k, x] of v.e) {
          ascii(` /${k} `);
          write(x);
        }
        ascii(" >>");
        break;
      case "array":
        ascii("[");
        for (const x of v.v) {
          ascii(" ");
          write(x);
        }
        ascii(" ]");
        break;
      case "int":
        ascii(String(v.v));
        break;
      case "real":
        ascii(v.raw && Number(v.raw) === v.v ? v.raw : formatReal(v.v));
        break;
      case "bool":
        ascii(v.v ? "true" : "false");
        break;
      case "name":
        ascii(`/${v.v}`);
        break;
      case "string": {
        out.push(0x28);
        const bytes: number[] = v.latin1 ? [] : [0xfe, 0xff];
        for (let k = 0; k < v.v.length; k++) {
          const c = v.v.charCodeAt(k);
          if (v.latin1) bytes.push(c & 0xff);
          else bytes.push(c >> 8, c & 0xff);
        }
        for (const b of bytes) {
          if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
          out.push(b);
        }
        out.push(0x29);
        break;
      }
    }
  };
  if (top.t !== "dict") throw new Error("EngineData: the top level is a dictionary");
  for (const [k, x] of top.e) {
    ascii(` /${k} `);
    write(x);
  }
  return Uint8Array.from(out);
}
