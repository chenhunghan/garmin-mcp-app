/**
 * Shapes a demo response like Garmin's: every key the response schema requires
 * (packages/garmin-connect/tests/schemas.ts, generated from real responses) is
 * present, as null when the demo has no value for it. The generator only
 * writes the fields that matter; this adds the rest, recursively, including
 * inside array items.
 */
import type { z } from "zod";

interface Def {
  type: string;
  innerType?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  valueType?: z.ZodType;
}

const def = (s: z.ZodType) => (s as unknown as { _zod: { def: Def } })._zod.def;

function unwrap(s: z.ZodType): { schema: z.ZodType; optional: boolean } {
  let optional = false;
  let cur = s;
  for (;;) {
    const d = def(cur);
    if ((d.type === "nullable" || d.type === "optional") && d.innerType) {
      if (d.type === "optional") optional = true;
      cur = d.innerType;
    } else {
      return { schema: cur, optional };
    }
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `value` with every key `schema` requires (null when missing). */
export function fill(schema: z.ZodType | undefined, value: unknown): unknown {
  if (!schema || value === undefined || value === null) return value ?? null;
  const d = def(unwrap(schema).schema);
  if (d.type === "object" && isPlainObject(value) && d.shape) {
    const out: Record<string, unknown> = {};
    for (const [key, sub] of Object.entries(d.shape)) {
      if (key in value) out[key] = fill(sub, value[key]);
      else if (!unwrap(sub).optional) out[key] = null;
    }
    for (const [key, v] of Object.entries(value)) {
      if (!(key in out)) out[key] = v;
    }
    return out;
  }
  if (d.type === "record" && isPlainObject(value) && d.valueType) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(d.valueType, v)]));
  }
  if (d.type === "array" && Array.isArray(value) && d.element) {
    return value.map((v) => fill(d.element, v));
  }
  return value;
}
