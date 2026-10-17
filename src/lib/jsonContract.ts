/** Small validator for the JSON Schema subset used by Director tool contracts. */
export function contractViolation(
  value: unknown,
  schema: any,
  path = "$",
): string | undefined {
  if (!schema) return;
  if (schema.enum && !schema.enum.includes(value))
    return `${path} must match one of the allowed values`;
  if (Array.isArray(schema.type))
    return schema.type.some(
      (type: string) => !contractViolation(value, { ...schema, type }, path),
    )
      ? undefined
      : `${path} must be ${schema.type.join(" or ")}`;
  if (schema.type === "null")
    return value === null ? undefined : `${path} must be null`;
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
    if (value.length < (schema.minLength ?? 0))
      return `${path} must have at least ${schema.minLength} characters`;
    if (value.length > (schema.maxLength ?? 50_000))
      return `${path} exceeds the maximum string length`;
    return;
  }
  if (schema.type === "boolean")
    return typeof value === "boolean" ? undefined : `${path} must be a boolean`;
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value))
      return `${path} must be a finite number`;
    if (schema.type === "integer" && !Number.isInteger(value))
      return `${path} must be an integer`;
    if (value < (schema.minimum ?? -Infinity))
      return `${path} must be >= ${schema.minimum}; received ${value}`;
    if (value > (schema.maximum ?? Infinity))
      return `${path} must be <= ${schema.maximum}; received ${value}`;
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (value.length < (schema.minItems ?? 0))
      return `${path} needs at least ${schema.minItems} items; received ${value.length}`;
    if (value.length > (schema.maxItems ?? 1000))
      return `${path} has too many items; received ${value.length}`;
    for (const [index, item] of value.entries()) {
      const error = contractViolation(item, schema.items, `${path}[${index}]`);
      if (error) return error;
    }
    return;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return `${path} must be an object`;
    const record = value as Record<string, unknown>;
    for (const key of schema.required || [])
      if (record[key] === undefined) return `${path}.${key} is required`;
    for (const [key, item] of Object.entries(record)) {
      if (!schema.properties?.[key]) {
        if (schema.additionalProperties === false)
          return `${path}.${key} is not allowed; remove this field`;
      } else {
        const error = contractViolation(
          item,
          schema.properties[key],
          `${path}.${key}`,
        );
        if (error) return error;
      }
    }
    return;
  }
  return `${path} has an unsupported schema type`;
}

export function matchesContract(value: unknown, schema: any): boolean {
  return !contractViolation(value, schema);
}
