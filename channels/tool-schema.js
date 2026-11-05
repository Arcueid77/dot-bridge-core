import { object } from '../router/common.js';

export function validateToolValue(value, schema) {
  if (value === null && Array.isArray(schema.type) && schema.type.includes('null')) return;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object') {
    object(value, Object.keys(schema.properties), schema.required);
    for (const [key, item] of Object.entries(value))
      validateToolValue(item, schema.properties[key]);
  } else if (type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length > schema.maxItems ||
      value.length < (schema.minItems ?? 0)
    )
      throw Error('Invalid tool array');
    for (const item of value) validateToolValue(item, schema.items);
  } else if (type === 'integer') {
    if (
      !Number.isSafeInteger(value) ||
      value < (schema.minimum ?? 0) ||
      value > (schema.maximum ?? Number.MAX_SAFE_INTEGER)
    )
      throw Error('Invalid tool integer');
  } else if (typeof value !== type) throw Error('Invalid tool value');
  if (typeof value === 'string') {
    if (
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? 2048) ||
      !value.isWellFormed() ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
    )
      throw Error('Invalid tool string');
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      throw Error('Invalid tool reference');
  }
  if (
    schema.format === 'date-time' &&
    (typeof value !== 'string' ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value)
  )
    throw Error('Invalid tool timestamp');
  if (
    (schema.const !== undefined && value !== schema.const) ||
    (schema.enum && !schema.enum.includes(value))
  )
    throw Error('Invalid tool enum');
}
