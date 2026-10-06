// =============================================================================
// Freebuff tools schema 规范化（T202a）
// -----------------------------------------------------------------------------
// 逐函数移植 Go 原版 Quorinex/Freebuff2API@a1c1035 server.go（每处注释标 `server.go:行号`）。
//
// 目的：把客户端（尤其 LobeChat 一类）产出的、带 JSON Schema 高级构造的
// tools[].function.parameters 改写成上游后端能保守解析的子集：
//   1) 解析本地 $ref（#/definitions/X 与 #/$defs/X）并内联定义；
//   2) 简化 nullable 构造（anyOf/oneOf 里的 null 分支、type 数组里的 "null"、
//      旧式 `nullable:true`）；
//   3) 收束 type / enum / const 的退化形态。
//
// 上游接入点：provider.ts 的 buildUpstreamBody（← server.go:357 injectUpstreamMetadata
// 里 server.go:364-366 的那段调用）。
//
// 与 Go 的刻意取舍（报告登记）：
//   - Go 直接在 clone 出来的 payload 上**就地改写** tools 切片；TS 侧为保持
//     "不动调用方请求对象"的语义，normalizeToolSchemas 先深拷贝再改写并返回，
//     调用方用返回值覆盖 source.tools（观察行为一致：上游收到规范化后的体、
//     调用方入参不被污染）。
//   - cloneMap / cloneSlice 一并移植（server.go:658/673），供深拷贝使用。
// =============================================================================

/** server.go:422 —— normalizeToolSchemas 传入的 maxDepth（12）。 */
export const MAX_SCHEMA_DEPTH = 12;

/** 宽松的 JSON 对象判定（数组不算对象）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * server.go:408 normalizeToolSchemas。
 * 逐个 tool 取 function.parameters 做规范化；非函数型 / 无 parameters 的 tool 跳过。
 *
 * 注：Go 就地改写切片；这里返回深拷贝后的新切片（见文件头取舍说明）。
 */
export function normalizeToolSchemas(tools: readonly unknown[]): unknown[] {
  const cloned = cloneSlice(tools as unknown[]);
  for (const tool of cloned) {
    if (!isRecord(tool)) continue;
    const fn = tool['function'];
    if (!isRecord(fn)) continue;
    const params = fn['parameters'];
    if (!isRecord(params)) continue;
    fn['parameters'] = normalizeSchemaMap(params, extractDefinitions(params), MAX_SCHEMA_DEPTH);
  }
  return cloned;
}

// ─── definitions 提取/合并（server.go:426-460）──────────────────────────────

/**
 * server.go:427 extractDefinitions —— 合并 "definitions" 与 "$defs"。
 * 两者都空时返回 undefined（对应 Go 的 nil）。
 */
export function extractDefinitions(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  const definitions = schema['definitions'];
  if (isRecord(definitions)) {
    for (const [key, value] of Object.entries(definitions)) merged[key] = value;
  }
  const dollarDefs = schema['$defs'];
  if (isRecord(dollarDefs)) {
    for (const [key, value] of Object.entries(dollarDefs)) merged[key] = value;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** server.go:445 mergeDefinitions —— 局部覆盖父级；任一为空则取另一方。 */
function mergeDefinitions(
  parent: Record<string, unknown> | undefined,
  local: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!parent || Object.keys(parent).length === 0) return local;
  if (!local || Object.keys(local).length === 0) return parent;
  return { ...parent, ...local };
}

// ─── 递归规范化（server.go:462-513）────────────────────────────────────────

/** server.go:462 normalizeSchemaValue —— 分发到 map / slice 分支。 */
function normalizeSchemaValue(
  value: unknown,
  defs: Record<string, unknown> | undefined,
  maxDepth: number,
): unknown {
  if (isRecord(value)) return normalizeSchemaMap(value, defs, maxDepth);
  if (Array.isArray(value)) return normalizeSchemaSlice(value, defs, maxDepth);
  return value;
}

/**
 * server.go:473 normalizeSchemaMap。
 * 到达深度上限直接返回克隆（不再改写）；$ref 节点解析后递归；否则逐字段递归，
 * 再删除 definitions/$defs/nullable 并做 type/enum/const 与 anyOf/oneOf 简化。
 */
export function normalizeSchemaMap(
  node: Record<string, unknown>,
  defs: Record<string, unknown> | undefined,
  maxDepth: number,
): Record<string, unknown> {
  if (maxDepth <= 0) return cloneMap(node);

  const mergedDefs = mergeDefinitions(defs, extractDefinitions(node));
  const replaced = tryResolveRef(node, mergedDefs);
  if (replaced !== undefined && replaced !== null) {
    if (isRecord(replaced)) return normalizeSchemaMap(replaced, mergedDefs, maxDepth - 1);
    return cloneMap(node);
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    normalized[key] = normalizeSchemaValue(value, mergedDefs, maxDepth - 1);
  }

  delete normalized['definitions'];
  delete normalized['$defs'];
  delete normalized['nullable'];

  let result = simplifyNullableCombinator(normalized, 'anyOf');
  result = simplifyNullableCombinator(result, 'oneOf');
  normalizeTypeField(result);
  normalizeEnumField(result);
  normalizeConstField(result);

  return result;
}

/** server.go:504 normalizeSchemaSlice。 */
function normalizeSchemaSlice(
  slice: unknown[],
  defs: Record<string, unknown> | undefined,
  maxDepth: number,
): unknown[] {
  if (maxDepth <= 0) return cloneSlice(slice);
  return slice.map((value) => normalizeSchemaValue(value, defs, maxDepth - 1));
}

// ─── nullable 简化（server.go:515-552 / 617-628）───────────────────────────

/**
 * server.go:515 simplifyNullableCombinator —— 去掉 anyOf/oneOf 中的 null 分支：
 * 过滤后 0 个 → 删除该 key；恰好 1 个且为对象 → 把该分支并进当前 schema；
 * 否则写回过滤后的数组。
 */
function simplifyNullableCombinator(
  schema: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const rawOptions = schema[key];
  if (!Array.isArray(rawOptions)) return schema;

  const filtered = rawOptions.filter((option) => !(isRecord(option) && isNullSchema(option)));

  if (filtered.length === 0) {
    delete schema[key];
    return schema;
  }

  if (filtered.length === 1 && isRecord(filtered[0])) {
    const optionMap = filtered[0];
    const merged: Record<string, unknown> = {};
    for (const [existingKey, existingValue] of Object.entries(schema)) {
      if (existingKey === key) continue;
      merged[existingKey] = existingValue;
    }
    for (const [optionKey, optionValue] of Object.entries(optionMap)) {
      merged[optionKey] = optionValue;
    }
    return merged;
  }

  schema[key] = filtered;
  return schema;
}

/**
 * server.go:617 isNullSchema —— 判定一个分支是否"只表示 null"：
 * type=="null" / const==null / enum==[null]。
 */
function isNullSchema(schema: Record<string, unknown>): boolean {
  if (schema['type'] === 'null') return true;
  if ('const' in schema && (schema['const'] === null || schema['const'] === undefined)) return true;
  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && enumValues.length === 1) {
    const only = enumValues[0];
    if (only === null || only === undefined) return true;
  }
  return false;
}

// ─── type / enum / const 收束（server.go:554-615）──────────────────────────

/**
 * server.go:554 normalizeTypeField —— type 为字符串则原样保留；为数组时
 * 过滤掉 "null"/空白，取第一个非 null 类型（上游只接受单一原语类型）。
 */
function normalizeTypeField(schema: Record<string, unknown>): void {
  if (!('type' in schema)) return;
  const rawType = schema['type'];
  if (typeof rawType === 'string') return;
  if (!Array.isArray(rawType)) return;

  const nonNullTypes: string[] = [];
  for (const entry of rawType) {
    if (typeof entry !== 'string' || entry === 'null' || entry.trim() === '') continue;
    nonNullTypes.push(entry);
  }

  if (nonNullTypes.length === 0) delete schema['type'];
  else schema['type'] = nonNullTypes[0];
}

/**
 * server.go:586 normalizeEnumField —— 丢弃 null 分支并按「类型:值」去重
 * （对应 Go `fmt.Sprintf("%T:%v", entry, entry)`；对象用稳定序列化以保证
 * 与 Go 排序输出等价的去重语义）。
 */
function normalizeEnumField(schema: Record<string, unknown>): void {
  const enumValues = schema['enum'];
  if (!Array.isArray(enumValues)) return;

  const filtered: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of enumValues) {
    if (entry === null || entry === undefined) continue;
    const key = enumKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    filtered.push(entry);
  }

  if (filtered.length === 0) delete schema['enum'];
  else schema['enum'] = filtered;
}

/** server.go:611 normalizeConstField —— const==null 时删除。 */
function normalizeConstField(schema: Record<string, unknown>): void {
  if ('const' in schema && (schema['const'] === null || schema['const'] === undefined)) {
    delete schema['const'];
  }
}

// ─── $ref 解析（server.go:630-656）─────────────────────────────────────────

/**
 * server.go:632 tryResolveRef —— 仅当节点是**纯** $ref 对象（len==1）且指向
 * #/definitions/X 或 #/$defs/X 时，返回该定义的深拷贝；否则返回 undefined
 * （对应 Go 的 nil，调用方据此判定"未替换"）。
 */
export function tryResolveRef(
  node: Record<string, unknown>,
  defs: Record<string, unknown> | undefined,
): unknown {
  const ref = node['$ref'];
  if (typeof ref !== 'string') return undefined;
  if (Object.keys(node).length !== 1) return undefined;

  let name = '';
  if (ref.startsWith('#/definitions/')) name = ref.slice('#/definitions/'.length);
  else if (ref.startsWith('#/$defs/')) name = ref.slice('#/$defs/'.length);
  if (name === '') return undefined;

  if (!defs || !Object.prototype.hasOwnProperty.call(defs, name)) return undefined;
  const def = defs[name];
  // 深拷贝，避免改写原始定义（Go 的 cloneMap 语义）。
  if (isRecord(def)) return cloneMap(def);
  return def;
}

// ─── 深拷贝（server.go:658-686）────────────────────────────────────────────

/** server.go:658 cloneMap。 */
function cloneMap(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) output[key] = cloneValue(value);
  return output;
}

/** server.go:673 cloneSlice。 */
function cloneSlice(input: unknown[]): unknown[] {
  return input.map(cloneValue);
}

function cloneValue(value: unknown): unknown {
  if (isRecord(value)) return cloneMap(value);
  if (Array.isArray(value)) return cloneSlice(value);
  return value;
}

// ─── enum 去重键（Go `%T:%v` 的等价物）─────────────────────────────────────

function enumKey(entry: unknown): string {
  const type = typeof entry;
  if (entry === null) return 'null';
  if (type === 'object') return `object:${stableJson(entry)}`;
  return `${type}:${String(entry)}`;
}

/** 键排序的稳定序列化（对齐 Go fmt 对 map 的排序打印，保证去重顺序无关）。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
