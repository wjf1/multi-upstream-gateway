// =============================================================================
// Provider 核心契约的类型编译测试（T101 DoD）
// -----------------------------------------------------------------------------
// 两层防护：
//   1. 编译期：本文件在 `tsc --noEmit -p tsconfig.test.json` 的检查范围内，
//      下方的 StubProvider / StubPool 必须 implements 契约——任何签名漂移
//      （必填字段缺失、返回类型变化、泛型约束破坏）都会让 typecheck 红；
//   2. 运行期：错误码 5 张表的完整性断言（HINTS/STATUS/TYPE 对每个码都有值），
//      防止后续往 ErrorCode 加码时漏表导致运行期 undefined。
// =============================================================================

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ErrorCode,
  ProxyError,
  type ErrorCodeName,
} from '../src/utils/errors.js';
import {
  type AccountLease,
  type BaseAccount,
  type ChatOptions,
  type IAccountPool,
  type IProvider,
  type OpenAIModel,
  type PoolSnapshot,
  type ProviderHealth,
  type ProviderName,
  type ProbeResult,
  type RoutingContext,
  type UsageSnapshot,
} from '../src/providers/core/interface.js';
import type { AccountInfo, OpenAIChatRequest } from '../src/types/index.js';

// ─── 编译期契约守卫：签名漂移会让 `npm run typecheck` 红 ─────────────────────

class StubProvider implements IProvider {
  readonly name: ProviderName = 'commandcode';
  readonly displayName = 'Stub';

  async initialize(_config: unknown): Promise<void> {}
  async health(): Promise<ProviderHealth> {
    return { healthy: true, total: 0, cooldownCount: 0, disabledCount: 0 };
  }
  async probe(): Promise<ProbeResult> {
    return { healthy: true, checkedAt: new Date(0).toISOString() };
  }
  async listModels(): Promise<OpenAIModel[]> {
    return [];
  }
  async *chatCompletion(_req: OpenAIChatRequest, _opts: ChatOptions): AsyncIterable<string> {}
  extractUsage(_events: unknown[]): UsageSnapshot {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
  }
  listAccounts(): AccountInfo[] {
    return [];
  }
  async addAccount(_credentials: unknown): Promise<AccountInfo> {
    throw new Error('stub');
  }
  removeAccount(_id: string): void {}
  pauseAccount(_id: string): void {}
  resumeAccount(_id: string): void {}
  enable(): void {}
  disable(): void {}
  isEnabled(): boolean {
    return true;
  }
  updateConfig(_config: unknown): void {}
  async destroy(): Promise<void> {}
}

interface StubAccount extends BaseAccount {
  points: number;
}

class StubPool implements IAccountPool<StubAccount> {
  async selectAccount(_ctx: RoutingContext): Promise<AccountLease<StubAccount>> {
    throw new Error('stub');
  }
  releaseLease(_lease: AccountLease<StubAccount>, _result: 'success' | 'error' | 'ratelimit'): void {}
  snapshot(): PoolSnapshot {
    return { total: 0, healthy: 0, cooldown: 0, disabled: 0, inFlight: 0, accounts: [] };
  }
}

describe('IProvider 契约（编译期）', () => {
  it('关键方法签名与方案 §3.1 逐字段对齐', () => {
    const p: IProvider = new StubProvider();
    expectTypeOf(p.name).toEqualTypeOf<ProviderName>();
    expectTypeOf<ReturnType<IProvider['chatCompletion']>>().toEqualTypeOf<AsyncIterable<string>>();
    expectTypeOf<ChatOptions['requestId']>().toEqualTypeOf<string>();
    expectTypeOf(p.extractUsage).parameter(0).toEqualTypeOf<unknown[]>();
    expectTypeOf(p.health()).resolves.toEqualTypeOf<ProviderHealth>();
  });

  it('ProviderName 是三个命名空间的联合', () => {
    expectTypeOf<ProviderName>().toEqualTypeOf<'commandcode' | 'freebuff' | 'workbuddy'>();
  });

  it('IAccountPool 泛型约束到 BaseAccount', () => {
    expectTypeOf(new StubPool()).toExtend<IAccountPool<StubAccount>>();
    // @ts-expect-error 不满足 BaseAccount 的类型不能充当池元素
    expectTypeOf<IAccountPool<{ nope: string }>>();
  });
});

// ─── 运行期：错误码表完整性（新增码漏表 = 红）────────────────────────────────

const NEW_CODES = [
  'NO_PROVIDER_AVAILABLE',
  'PROVIDER_DEGRADED',
  'RISK_DISCLAIMER_NOT_ACCEPTED',
  'UPSTREAM_ACCOUNT_UNAVAILABLE',
  'MODEL_AMBIGUOUS',
] as const;

describe('Provider 层新增错误码（master-plan v1.2 §3.1）', () => {
  const EXPECTED_STATUS: Record<string, number> = {
    NO_PROVIDER_AVAILABLE: 503,
    PROVIDER_DEGRADED: 503,
    RISK_DISCLAIMER_NOT_ACCEPTED: 403,
    UPSTREAM_ACCOUNT_UNAVAILABLE: 409,
    MODEL_AMBIGUOUS: 400,
  };

  it('五个新码全部存在且状态码正确', () => {
    for (const code of NEW_CODES) {
      expect(ErrorCode, `ErrorCode.${code}`).toHaveProperty(code);
      const err = new ProxyError(code as ErrorCodeName, 'probe');
      expect(err.status, `${code}.status`).toBe(EXPECTED_STATUS[code]);
    }
  });

  it('每个错误码在 5 张表中都有完整映射（HINT/STATUS/OPENAI/ANTHROPIC）', () => {

    const allCodes = Object.values(ErrorCode) as ErrorCodeName[];
    expect(allCodes.length).toBeGreaterThanOrEqual(23);
    for (const code of allCodes) {
      const e = new ProxyError(code, 'probe');
      expect(e.hint, `${code} 应有可执行提示`).toBeTruthy();
      expect(e.openAIPayload().type, `${code} 应有 OpenAI type`).toBeTruthy();
      expect(e.anthropicPayload().error.type, `${code} 应有 Anthropic type`).toBeTruthy();
    }
  });

  it('合规门错误码在 OpenAI/Anthropic 两出口分别是 permission_error / permission_error', () => {
    const e = new ProxyError(ErrorCode.RISK_DISCLAIMER_NOT_ACCEPTED, 'disclaimer');
    expect(e.openAIPayload().type).toBe('permission_error');
    expect(e.anthropicPayload().error.type).toBe('permission_error');
  });

  it('MODEL_AMBIGUOUS 在两出口都是 invalid_request_error(400)', () => {
    const e = new ProxyError(ErrorCode.MODEL_AMBIGUOUS, 'bare model is ambiguous');
    expect(e.status).toBe(400);
    expect(e.openAIPayload().type).toBe('invalid_request_error');
    expect(e.anthropicPayload().error.type).toBe('invalid_request_error');
  });
});
