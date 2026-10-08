// =============================================================================
// T302：本地状态持久化原语（src/utils/state-store.ts）
// -----------------------------------------------------------------------------
// 覆盖 master-plan v1.2 §3.4 的两条硬约束：
//   - 状态变更在临界区内完成，**锁内禁止 IO**（本测试用「临界区内读盘仍是旧内容」取证）；
//   - 写入走**临时文件 + rename 原子替换**，损坏文件可被识别而不被静默覆盖。
// 以及 kill -9 一致性的前提：任何时刻磁盘上都是完整可解析的整份状态。
// =============================================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AsyncMutex,
  DEFAULT_STATE_RELATIVE_PATH,
  JsonStateStore,
  StateLockTimeoutError,
  STATE_PATH_ENV,
  resolveConfiguredStatePath,
  withFileLock,
  type ParseResult,
} from '../src/utils/state-store.js';

interface Doc {
  version: number;
  count: number;
  note?: string;
}

function parseDoc(raw: unknown): ParseResult<Doc> {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return { ok: false, error: 'not an object' };
  if (typeof o.version !== 'number') return { ok: false, error: 'version missing' };
  if (typeof o.count !== 'number') return { ok: false, error: 'count missing' };
  return { ok: true, value: { version: o.version, count: o.count, note: o.note as string | undefined } };
}

let dir = '';
const statePath = () => path.join(dir, 'state.json');
const newStore = (filePath = statePath()) =>
  new JsonStateStore<Doc>({ filePath, parse: parseDoc, initial: () => ({ version: 1, count: 0 }) });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ccproxy-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('JsonStateStore 载入', () => {
  it('文件缺失：落到 initial 并立即建基线（可解析）', async () => {
    const store = newStore();
    const outcome = await store.initialize();
    expect(outcome.status).toBe('missing');
    expect(store.getState()).toEqual({ version: 1, count: 0 });
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({ version: 1, count: 0 });
  });

  it('文件存在：载入其内容', async () => {
    writeFileSync(statePath(), JSON.stringify({ version: 1, count: 7, note: 'x' }), 'utf8');
    const store = newStore();
    expect((await store.initialize()).status).toBe('loaded');
    expect(store.getState()).toEqual({ version: 1, count: 7, note: 'x' });
  });

  it('JSON 损坏：报告 corrupted，且不覆盖原文件（留给调用方重建）', async () => {
    writeFileSync(statePath(), '{ this is not json', 'utf8');
    const store = newStore();
    const outcome = await store.initialize();
    expect(outcome.status).toBe('corrupted');
    expect(outcome.status === 'corrupted' && outcome.reason).toMatch(/invalid JSON/);
    expect(store.getState()).toEqual({ version: 1, count: 0 });
    // 损坏的原文件字节必须原样保留：调用方可能仍想抢救/取证。
    expect(readFileSync(statePath(), 'utf8')).toBe('{ this is not json');
  });

  it('schema 不匹配同样判 corrupt（reason 来自 parse）', async () => {
    writeFileSync(statePath(), JSON.stringify({ version: 1 }), 'utf8');
    const store = newStore();
    const outcome = await store.initialize();
    expect(outcome.status).toBe('corrupted');
    expect(outcome.status === 'corrupted' && outcome.reason).toBe('count missing');
  });

  it('recover 用重建结果替换并落盘', async () => {
    writeFileSync(statePath(), 'garbage', 'utf8');
    const store = newStore();
    await store.initialize();
    await store.recover({ version: 1, count: 42, note: 'rebuilt' });
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({ version: 1, count: 42, note: 'rebuilt' });
  });
});

describe('JsonStateStore 写入', () => {
  it('原子替换：不残留 .tmp / .lock', async () => {
    const store = newStore();
    await store.initialize();
    await store.mutate((s) => ({ ...s, count: s.count + 1 }));
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
    expect(leftovers).toEqual([]);
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).count).toBe(1);
  });

  it('并发 mutate 不丢更新（串行落盘 + 后发不会覆盖先发）', async () => {
    const store = newStore();
    await store.initialize();
    await Promise.all(Array.from({ length: 12 }, () => store.mutate((s) => ({ ...s, count: s.count + 1 }))));
    expect(store.getState().count).toBe(12);
    await store.drain();
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).count).toBe(12);
  });

  it('锁内禁止 IO：临界区内磁盘仍是旧内容，落盘发生在临界区之后', async () => {
    writeFileSync(statePath(), JSON.stringify({ version: 1, count: 1 }), 'utf8');
    const store = newStore();
    await store.initialize();
    let seenInsideCritical: number | null = null;
    await store.mutate((s) => {
      seenInsideCritical = (JSON.parse(readFileSync(statePath(), 'utf8')) as Doc).count;
      return { ...s, count: s.count + 100 };
    });
    expect(seenInsideCritical).toBe(1); // 临界区内没有写入发生
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).count).toBe(101);
  });

  it('抢不到锁时写盘失败，但旧文件保持完整（不产生半截文件）', async () => {
    writeFileSync(statePath(), JSON.stringify({ version: 1, count: 5 }), 'utf8');
    const store = new JsonStateStore<Doc>({
      filePath: statePath(),
      parse: parseDoc,
      initial: () => ({ version: 1, count: 0 }),
      lock: { timeoutMs: 40, retryMs: 5, staleMs: 60_000 },
    });
    await store.initialize();
    // 手工占坑：新鲜 mtime 的锁文件，接管阈值远大于测试时长 → 必然超时。
    writeFileSync(`${statePath()}.lock`, JSON.stringify({ pid: 999_999, at: Date.now() }), 'utf8');
    await expect(store.mutate((s) => ({ ...s, count: 6 }))).rejects.toBeInstanceOf(StateLockTimeoutError);
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).count).toBe(5);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('drain 幂等：无待写时立即返回，退出前可安全调用', async () => {
    const store = newStore();
    await store.initialize();
    await store.mutate((s) => ({ ...s, count: 9 }));
    await store.drain();
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).count).toBe(9);
  });
});

describe('withFileLock', () => {
  it('第二个持锁者排队等待，前一个释放后才进入（互斥）', async () => {
    const target = path.join(dir, 'x.json');
    const order: string[] = [];
    await Promise.all([
      withFileLock(target, async () => {
        order.push('a-in');
        await new Promise((r) => setTimeout(r, 40));
        order.push('a-out');
      }),
      withFileLock(target, async () => {
        order.push('b-in');
        order.push('b-out');
      }),
    ]);
    // 谁先抢到不做保证：两者同时发起，胜出取决于谁的 open 先落地（曾经断言 a 必先，
    // 在全量并发下偶发红）。契约只保证**临界区不交错**——同一持有者的 in/out 必相邻，
    // 且两个持有者不同。等待行为由此可证：后到者只有在先到者 out 之后才进入。
    expect(order).toHaveLength(4);
    expect(order[0].split('-')[0]).toBe(order[1].split('-')[0]);
    expect(order[2].split('-')[0]).toBe(order[3].split('-')[0]);
    expect(order[0].split('-')[0]).not.toBe(order[2].split('-')[0]);
  });

  it('持锁者被 kill -9（锁文件残留）时，超龄锁可被接管', async () => {
    const target = path.join(dir, 'y.json');
    writeFileSync(`${target}.lock`, JSON.stringify({ pid: 999_999, at: 0 }), 'utf8');
    // mtimeMs 不可能被伪造，这里把接管阈值设为 0 来模拟「锁已超龄」。
    const value = await withFileLock(target, async () => 'ok', { staleMs: -1, timeoutMs: 200, retryMs: 5 });
    expect(value).toBe('ok');
    expect(readdirSync(dir).filter((f) => f.endsWith('.lock'))).toEqual([]);
  });

  it('锁超时抛 StateLockTimeoutError', async () => {
    const target = path.join(dir, 'z.json');
    writeFileSync(`${target}.lock`, '{}', 'utf8');
    await expect(
      withFileLock(target, async () => 'never', { staleMs: 60_000, timeoutMs: 30, retryMs: 5 }),
    ).rejects.toBeInstanceOf(StateLockTimeoutError);
  });
});

describe('AsyncMutex', () => {
  it('任务严格串行，且前一个失败不阻断后续', async () => {
    const mutex = new AsyncMutex();
    const seq: number[] = [];
    const p1 = mutex.runExclusive(async () => {
      seq.push(1);
      await new Promise((r) => setTimeout(r, 10));
      seq.push(2);
      throw new Error('boom');
    });
    const p2 = mutex.runExclusive(() => {
      seq.push(3);
    });
    await expect(p1).rejects.toThrow('boom');
    await p2;
    expect(seq).toEqual([1, 2, 3]);
    expect(mutex.locked).toBe(false);
  });
});

describe('resolveConfiguredStatePath', () => {
  const saved = process.env[STATE_PATH_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[STATE_PATH_ENV];
    else process.env[STATE_PATH_ENV] = saved;
  });

  it('环境变量优先', async () => {
    process.env[STATE_PATH_ENV] = path.join(dir, 'custom.json');
    expect(await resolveConfiguredStatePath()).toBe(path.join(dir, 'custom.json'));
  });

  it('无环境变量时回落到 data/state.json（绝对路径）', async () => {
    delete process.env[STATE_PATH_ENV];
    const resolved = await resolveConfiguredStatePath();
    expect(path.basename(resolved)).toBe('state.json');
    expect(resolved.endsWith(DEFAULT_STATE_RELATIVE_PATH)).toBe(true);
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('显式路径参数在环境变量缺席时生效', async () => {
    delete process.env[STATE_PATH_ENV];
    const explicit = path.join(dir, 'explicit.json');
    expect(await resolveConfiguredStatePath(explicit)).toBe(explicit);
  });
});

describe('边角：目录不存在时自动创建', () => {
  it('深层目录可写', async () => {
    const deep = path.join(dir, 'a', 'b', 'state.json');
    mkdirSync(path.join(dir, 'a'), { recursive: true });
    const store = newStore(deep);
    await store.initialize();
    expect(JSON.parse(readFileSync(deep, 'utf8')).version).toBe(1);
  });
});
