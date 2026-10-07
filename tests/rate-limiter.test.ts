// =============================================================================
// 限流器测试（T105 DoD）
// -----------------------------------------------------------------------------
// 覆盖：
//   1. 滑动窗桶：RPM（请求数）与 TPM（token 预扣）两个维度；
//   2. 全局桶 + per-provider 桶相互独立；
//   3. 429 的 Retry-After 建议值落在 (0, 60] 且随窗口剩余时间收敛；
//   4. 'inherit' 语义：per-provider 桶沿用全局限额（独立计数）；
//   5. env 兜底解析（T213 接 UnifiedConfig 前的配置通道）。
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  RateLimiter,
  SlidingWindowRateLimiter,
  resolveRateLimitConfigFromEnv,
} from '../src/utils/rate-limiter.js';

describe('SlidingWindowRateLimiter', () => {
  it('RPM：窗口内请求数超限即拒绝，retryAfterSeconds 为窗口剩余秒数', () => {
    const limiter = new SlidingWindowRateLimiter({ rpm: 2 });
    const t0 = 1_000_000;
    expect(limiter.tryAcquire(0, t0).allowed).toBe(true);
    expect(limiter.tryAcquire(0, t0 + 1000).allowed).toBe(true);
    const third = limiter.tryAcquire(0, t0 + 2000);
    expect(third.allowed).toBe(false);
    // 最旧请求在 t0,60s 窗口,还剩 58s
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(57);
    expect(third.retryAfterSeconds).toBeLessThanOrEqual(58);
  });

  it('RPM：窗口滑出后恢复放行', () => {
    const limiter = new SlidingWindowRateLimiter({ rpm: 1 });
    const t0 = 2_000_000;
    expect(limiter.tryAcquire(0, t0).allowed).toBe(true);
    expect(limiter.tryAcquire(0, t0 + 1000).allowed).toBe(false);
    expect(limiter.tryAcquire(0, t0 + 61_000).allowed).toBe(true);
  });

  it('TPM：token 预扣超限即拒绝（请求体大小估算输入侧）', () => {
    const limiter = new SlidingWindowRateLimiter({ tpm: 100 });
    expect(limiter.tryAcquire(60).allowed).toBe(true);
    expect(limiter.tryAcquire(30).allowed).toBe(true);
    const third = limiter.tryAcquire(20);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('无配置（rpm/tpm 均缺省）时永不限制', () => {
    const limiter = new SlidingWindowRateLimiter({});
    for (let i = 0; i < 50; i++) expect(limiter.tryAcquire(1000).allowed).toBe(true);
  });
});

describe('RateLimiter —— 全局桶与 per-provider 桶', () => {
  it('全局桶独立计数,per-provider 桶互不影响（互不误伤的基础）', () => {
    const rl = new RateLimiter({ global: { rpm: 100 }, perProvider: { alpha: { rpm: 1 } } });
    expect(rl.checkProvider('alpha').allowed).toBe(true);
    expect(rl.checkProvider('alpha').allowed).toBe(false); // alpha 耗尽
    expect(rl.checkProvider('beta').allowed).toBe(true); // beta 不受限
    expect(rl.checkGlobal().allowed).toBe(true); // 全局桶远未耗尽
  });

  it('per-provider 桶耗尽不影响其他 provider 的桶与全局判定', () => {
    const rl = new RateLimiter({
      global: { rpm: 10 },
      perProvider: { commandcode: { rpm: 2 }, workbuddy: 'inherit' },
    });
    expect(rl.checkProvider('commandcode').allowed).toBe(true);
    expect(rl.checkProvider('commandcode').allowed).toBe(true);
    expect(rl.checkProvider('commandcode').allowed).toBe(false);
    // 'inherit' 继承全局限额(rpm 10)但独立计数
    expect(rl.checkProvider('workbuddy').allowed).toBe(true);
    expect(rl.checkProvider('workbuddy').allowed).toBe(true);
    // 未配置的 provider 不限
    expect(rl.checkProvider('freebuff').allowed).toBe(true);
  });

  it('无任何配置时全部放行（默认零破坏;T213 接 UnifiedConfig 后按配置生效）', () => {
    const rl = new RateLimiter({});
    for (let i = 0; i < 20; i++) {
      expect(rl.checkGlobal().allowed).toBe(true);
      expect(rl.checkProvider('commandcode').allowed).toBe(true);
    }
  });

  it('TPM 走全局桶时按预扣 token 判定', () => {
    const rl = new RateLimiter({ global: { tpm: 50 } });
    expect(rl.checkGlobal(30).allowed).toBe(true);
    expect(rl.checkGlobal(30).allowed).toBe(false);
  });
});

describe('resolveRateLimitConfigFromEnv —— env 兜底(T213 收口前通道)', () => {
  it('解析全局与 per-provider 环境变量', () => {
    const env = {
      RATE_LIMIT_GLOBAL_RPM: '120',
      RATE_LIMIT_GLOBAL_TPM: '80000',
      RATE_LIMIT_PROVIDER_COMMANDCODE_RPM: '60',
      RATE_LIMIT_PROVIDER_WORKBUDDY_TPM: '30000',
    };
    const cfg = resolveRateLimitConfigFromEnv(env);
    expect(cfg.global).toEqual({ rpm: 120, tpm: 80000 });
    expect(cfg.perProvider.commandcode).toEqual({ rpm: 60 });
    expect(cfg.perProvider.workbuddy).toEqual({ tpm: 30000 });
  });

  it('非法值与未设置项被忽略,结果为空配置', () => {
    const cfg = resolveRateLimitConfigFromEnv({
      RATE_LIMIT_GLOBAL_RPM: 'not-a-number',
      RATE_LIMIT_GLOBAL_TPM: '-5',
    });
    expect(cfg.global).toEqual({});
    expect(cfg.perProvider).toEqual({});
  });
});
