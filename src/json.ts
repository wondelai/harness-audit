/** Anything `JSON.parse` can return. */
export type JsonValue = string | number | boolean | null | Array<JsonValue> | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value !== 'object') {return false;}
  return Array.isArray(value) ? value.every(isJsonValue) : Object.values(value).every(isJsonValue);
}

/** `JSON.parse` that never throws: `undefined` for text that is not JSON. */
export function parseJson(text: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
