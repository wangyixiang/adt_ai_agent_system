/**
 * JSON Schema restricted subset (CAPABILITY_SPEC.md §5.1):
 * `type` / `properties` / `required` / `enum` / `items` / `description` / `default`.
 * `$ref` and the composition keywords are out of contract and rejected.
 */

export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

export interface JsonSchema {
  type?: JsonSchemaType;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: readonly unknown[];
  items?: JsonSchema;
  description?: string;
  default?: unknown;
}

export interface SchemaValidation {
  valid: boolean;
  errors: string[];
}

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "enum",
  "items",
  "description",
  "default",
]);

const COMPOSITION_KEYWORDS = ["$ref", "oneOf", "anyOf", "allOf", "not"] as const;

/**
 * Returns the first keyword outside the documented subset (CAPABILITY_SPEC.md
 * §5.1), or null. Structural traversal: `properties` values and `items` are
 * sub-schemas, so their keys are property names, not keywords.
 */
export function findUnsupportedKeyword(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  for (const keyword of COMPOSITION_KEYWORDS) {
    if (keyword in record) return keyword;
  }
  for (const key of Object.keys(record)) {
    if (!SUPPORTED_KEYWORDS.has(key)) return key;
  }

  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const child of Object.values(properties as Record<string, unknown>)) {
      const found = findUnsupportedKeyword(child);
      if (found) return found;
    }
  }
  if (record.items) {
    const found = findUnsupportedKeyword(record.items);
    if (found) return found;
  }
  return null;
}

function typeMatches(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}`);
    return;
  }

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path}: not one of the allowed values`);
  }

  if (schema.required && isPlainObject(value)) {
    for (const key of schema.required) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
  }

  if (schema.properties && isPlainObject(value)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (key in value) validate(child, value[key], `${path}.${key}`, errors);
    }
  }

  if (schema.items && Array.isArray(value)) {
    const items = schema.items;
    value.forEach((item, index) => validate(items, item, `${path}[${index}]`, errors));
  }
}

export function validateJsonSchema(schema: JsonSchema, value: unknown): SchemaValidation {
  const unsupported = findUnsupportedKeyword(schema);
  if (unsupported) {
    return { valid: false, errors: [`unsupported keyword: ${unsupported}`] };
  }

  const errors: string[] = [];
  validate(schema, value, "$", errors);
  return { valid: errors.length === 0, errors };
}
