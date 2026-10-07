// =============================================================================
// 用量 provider 维度测试（T109 DoD,master-plan v1.2 §3.9）
// -----------------------------------------------------------------------------
// 三态兼容读取(旧记录无 provider → commandcode)、queryUsage 筛选、
// summarizeByProvider 分口径聚合(美元与原生计量不混加)、20MB 轮转不变。
//
// 隔离纪律:USAGE_FILE_PATH 是模块加载时求值的常量——涉及文件读写的用例
// 必须动态 import + env 设置(vi.resetModules),禁止静态 import 后依赖 env
// 生效;纯函数(summarizeByProvider)可直接静态 import。
// =============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { summarizeByProvider, type UsageRecord } from '../src/utils/usage-store.js';

let work: { dir: string; usageFile: string };

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-provider-'));
  work = { dir, usageFile: path.join(dir, 'usage-history.jsonl') };
  process.env.USAGE_HISTORY_PATH = work.usageFile;
  delete process.env.USAGE_HISTORY_MAX_MB;
});

afterEach(() => {
  delete process.env.USAGE_HISTORY_PATH;
  delete process.env.USAGE_HISTORY_MAX_MB;
  fs.rmSync(work.dir, { recursive: true, force: true });
  vi.resetModules();
});

const LEGACY_RECORD = {
  timestamp: '2026-10-01T10:00:00.000Z',
  model: 'glm-5.2',
  inputTokens: 100,
  outputTokens: 50,
  timingMs: 1200,
  costUsd: 0.01,
  hasPricing: true,
  status: 'COMPLETED',
  mode: 'chat',
};

async function freshStore() {
  vi.resetModules();
  return import('../src/utils/usage-store.js');
}

describe('三态兼容读取（旧记录 → commandcode）', () => {
  it('缺 provider 字段的旧记录读入后归一化为 commandcode;新记录显式字段保留', async () => {
    const modern: UsageRecord = {
      ...LEGACY_RECORD,
      timestamp: '2026-10-02T10:00:00.000Z',
      provider: 'workbuddy',
      costUsd: null,
      native: { points: 12 },
    } as UsageRecord;
    fs.writeFileSync(
      work.usageFile,
      JSON.stringify(LEGACY_RECORD) + '\n' + JSON.stringify(modern) + '\n',
      'utf-8',
    );
    const store = await freshStore();
    const records = store.getUsageHistory();
    expect(records).toHaveLength(2);
    expect(records[0].provider).toBe('commandcode');
    expect(records[0].costUsd).toBe(0.01);
    expect(records[1].provider).toBe('workbuddy');
    expect(records[1].costUsd).toBeNull();
    expect(records[1].native?.points).toBe(12);
  });

  it('损坏行继续被跳过(归一化不破坏容错)', async () => {
    fs.writeFileSync(
      work.usageFile,
      'not-json\n' + JSON.stringify(LEGACY_RECORD) + '\n\n',
      'utf-8',
    );
    const store = await freshStore();
    expect(store.getUsageHistory()).toHaveLength(1);
  });
});

describe('queryUsage 筛选(provider/时间/模型)', () => {
  beforeEach(() => {
    const rows = [
      { ...LEGACY_RECORD, timestamp: '2026-10-01T08:00:00.000Z', model: 'glm-5.2', provider: 'commandcode', costUsd: 0.02 },
      { ...LEGACY_RECORD, timestamp: '2026-10-02T09:00:00.000Z', model: 'deepseek-v4.1', provider: 'freebuff', costUsd: 0 },
      { ...LEGACY_RECORD, timestamp: '2026-10-03T10:00:00.000Z', model: 'glm-5.2', provider: 'workbuddy', costUsd: null, native: { points: 3 } },
      { ...LEGACY_RECORD, timestamp: '2026-10-04T11:00:00.000Z', model: 'glm-5.2', provider: 'commandcode', costUsd: 0.04 },
    ];
    fs.writeFileSync(work.usageFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  });

  it('按 provider 筛选', async () => {
    const store = await freshStore();
    expect(store.queryUsage({ provider: 'commandcode' })).toHaveLength(2);
    expect(store.queryUsage({ provider: 'freebuff' })).toHaveLength(1);
    expect(store.queryUsage({ provider: 'workbuddy' })[0].native?.points).toBe(3);
  });

  it('按时间区间筛选(含边界)与按模型筛选', async () => {
    const store = await freshStore();
    expect(store.queryUsage({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-03T23:59:59.000Z' })).toHaveLength(2);
    expect(store.queryUsage({ from: '2026-10-02T09:00:00.000Z' })).toHaveLength(3);
    expect(store.queryUsage({ model: 'deepseek-v4.1' })).toHaveLength(1);
    expect(store.queryUsage({ provider: 'commandcode', model: 'glm-5.2', from: '2026-10-04T00:00:00.000Z' })).toHaveLength(1);
  });

  it('空条件返回全部', async () => {
    const store = await freshStore();
    expect(store.queryUsage()).toHaveLength(4);
  });
});

describe('summarizeByProvider(§3.9 分口径,禁止混加)', () => {
  it('美元上游求和;null 成本上游走 native 并列,costUsd=null', () => {
    const records = [
      { ...LEGACY_RECORD, provider: 'commandcode', costUsd: 0.02 } as UsageRecord,
      { ...LEGACY_RECORD, provider: 'commandcode', costUsd: 0.03 } as UsageRecord,
      { ...LEGACY_RECORD, provider: 'workbuddy', costUsd: null, native: { points: 5 } } as UsageRecord,
      { ...LEGACY_RECORD, provider: 'workbuddy', costUsd: null, native: { points: 7 } } as UsageRecord,
      { ...LEGACY_RECORD, provider: 'freebuff', costUsd: 0 } as UsageRecord,
    ];
    const out = summarizeByProvider(records);
    expect(out.map(s => s.provider)).toEqual(['commandcode', 'freebuff', 'workbuddy']);
    const cc = out.find(s => s.provider === 'commandcode')!;
    expect(cc.costUsd).toBeCloseTo(0.05, 10);
    expect(cc.runs).toBe(2);
    const wb = out.find(s => s.provider === 'workbuddy')!;
    expect(wb.costUsd).toBeNull();
    expect(wb.native?.points).toBe(12);
    const fb = out.find(s => s.provider === 'freebuff')!;
    expect(fb.costUsd).toBe(0); // 0 = 确定免费,与 null 语义分离
  });

  it('空数组返回空;缺 provider 字段的记录按 commandcode 计入', () => {
    expect(summarizeByProvider([])).toEqual([]);
    const out = summarizeByProvider([{ ...LEGACY_RECORD } as UsageRecord]);
    expect(out).toHaveLength(1);
    expect(out[0].provider).toBe('commandcode');
  });
});

describe('getUsageStats.byProvider(聚合出口)', () => {
  it('统计结果携带 provider 维聚合', async () => {
    fs.writeFileSync(
      work.usageFile,
      JSON.stringify({ ...LEGACY_RECORD, provider: 'commandcode', costUsd: 0.05 }) + '\n' +
      JSON.stringify({ ...LEGACY_RECORD, provider: 'workbuddy', costUsd: null, native: { points: 9 } }) + '\n',
      'utf-8',
    );
    const store = await freshStore();
    const stats = store.getUsageStats();
    expect(stats.byProvider).toHaveLength(2);
    expect(stats.byProvider.find(s => s.provider === 'workbuddy')!.native?.points).toBe(9);
    expect(stats.byProvider.find(s => s.provider === 'commandcode')!.costUsd).toBeCloseTo(0.05, 10);
  });
});

describe('轮转回归(USAGE_HISTORY_MAX_MB 生效)', () => {
  it('超限触发轮转且记录仍可读', async () => {
    process.env.USAGE_HISTORY_MAX_MB = '1';
    const store = await freshStore();
    const big = 'x'.repeat(200_000);
    for (let i = 0; i < 8; i++) {
      store.recordCompletion({
        ...LEGACY_RECORD,
        timestamp: new Date().toISOString(),
        model: `m${i}`,
        provider: 'commandcode',
        note: big,
      } as unknown as UsageRecord);
    }
    await store.flushPendingWrites();
    const size = fs.existsSync(work.usageFile) ? fs.statSync(work.usageFile).size : 0;
    expect(size).toBeLessThan(1.6 * 1024 * 1024); // 1MB 阈值轮转后远小于累计量
    expect(store.getUsageHistory().length).toBeGreaterThan(0); // 轮转保留后半,仍有数据
  });
});
