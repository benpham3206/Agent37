// Tiny JSON Schema checker for the subset used in contracts/ (no new dependencies).
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (v, t) => t === typeOf(v) || (t === 'number' && typeof v === 'number');
export function checkSchema(schema, value, at = '$') {
  const errors = [];
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => fits(value, t))) return [`${at}: expected ${types.join('|')}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: not one of ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${at}: missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...checkSchema(schema.properties[key], v, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected ${key}`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...checkSchema(schema.additionalProperties, v, `${at}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...checkSchema(schema.items, v, `${at}[${i}]`)));
  return errors;
}
