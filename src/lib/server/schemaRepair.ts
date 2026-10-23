/**
 * Mend the usual near-misses in a model's JSON before it is validated.
 *
 * A local model that is not grammar-constrained (Strata behind llama-swap) often
 * returns the right content in a slightly wrong shape: one item where a list was
 * asked for, extra fields, or a region ID with a few characters garbled. Its server
 * then rejects the whole reply. Asked in loose JSON mode instead, Komatose receives
 * the reply, mends only these unambiguous slips, and validates it itself, so a real
 * mistake still gets the usual correction retry.
 */

type Schema = Record<string, any>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const types = (schema: Schema): string[] =>
  Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];

/**
 * The list a bare item belongs in: the array of objects sharing the most fields with
 * it, holding at least half of that list's required fields. Fields the list does not
 * allow are dropped afterwards; anything still missing fails validation by name.
 */
function listForBareItem(value: Record<string, unknown>, schema: Schema): string | undefined {
  const keys = Object.keys(value);
  if (!keys.length) return undefined;
  const scored = Object.entries(schema.properties || {}).flatMap(([name, prop]: [string, any]) => {
    const items = prop?.items;
    if (!types(prop).includes('array') || !isObject(items) || !isObject(items.properties)) return [];
    const fields = Object.keys(items.properties);
    const shared = keys.filter((key) => fields.includes(key)).length;
    const needed: string[] = Array.isArray(items.required) ? (items.required as string[]) : [];
    const held = needed.filter((key) => key in value).length;
    if (!shared || held * 2 < needed.length) return [];
    if (shared < keys.length && items.additionalProperties !== false) return [];
    // A list whose every required field the item holds beats one it only half fits:
    // a region proposal without an ID is a new region, not an edit missing its ID.
    return [{ name, score: (held === needed.length ? 1000 : 0) + shared }];
  });
  if (!scored.length) return undefined;
  const best = Math.max(...scored.map((item) => item.score));
  const top = scored.filter((item) => item.score === best);
  return top.length === 1 ? top[0].name : undefined;
}

/** A garbled ID maps to the only allowed value sharing its first eight characters. */
function nearestId(value: string, allowed: unknown[]): string | undefined {
  if (value.length < 8) return undefined;
  const prefix = value.slice(0, 8);
  const matches = allowed.filter((item): item is string => typeof item === 'string' && item.length >= 8 && item.startsWith(prefix));
  return matches.length === 1 ? matches[0] : undefined;
}

export function repairToSchema(value: unknown, schema: Schema): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return value;
  const kinds = types(schema);
  if (kinds.includes('object') && isObject(value)) {
    const properties: Record<string, Schema> = schema.properties || {};
    const required: string[] = schema.required || [];
    let next: Record<string, unknown> = value;
    if (required.some((key) => !(key in value))) {
      const list = listForBareItem(value, schema);
      if (list) {
        next = { [list]: [value] };
        // Other lists the reply left out are empty: nothing was reported for them.
        for (const key of required) if (!(key in next) && types(properties[key] || {}).includes('array')) next[key] = [];
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(next)) {
      if (!(key in properties)) {
        if (schema.additionalProperties === false) continue;
        out[key] = field;
        continue;
      }
      const repaired = repairToSchema(field, properties[key]);
      // An empty optional text field is the same as leaving it out.
      if (repaired === '' && (properties[key].minLength ?? 0) > 0 && !required.includes(key)) continue;
      out[key] = repaired;
    }
    return out;
  }
  if (kinds.includes('array')) {
    const items = schema.items;
    const list = Array.isArray(value) ? value : isObject(value) && isObject(items) && types(items).includes('object') ? [value] : value;
    return Array.isArray(list) && isObject(items) ? list.map((item) => repairToSchema(item, items)) : list;
  }
  if (typeof value === 'string' && kinds.includes('string')) {
    let text = value;
    if (Array.isArray(schema.enum) && !schema.enum.includes(text)) text = nearestId(text, schema.enum) ?? text;
    if (typeof schema.maxLength === 'number' && text.length > schema.maxLength) text = text.slice(0, schema.maxLength);
    return text;
  }
  return value;
}
