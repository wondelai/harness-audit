/**
 * Own-property read from a literal lookup table. `undefined` for a key the table does not list,
 * including names every object has (`constructor`, `toString`), which `table[key]` would answer
 * with the prototype's member. The table keeps its literal type; only this parameter is open.
 */
export function lookup<V>(table: Readonly<Record<PropertyKey, V>>, key: PropertyKey): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
