// =============================================================================
// 日志脱敏测试（T105 DoD：全路径日志无凭据）
// -----------------------------------------------------------------------------
// sanitizeLog 是全部日志出口（logger.ts push、请求日志、审计 target/ip、错误
// 消息与堆栈）的唯一脱敏通道。这里锁定：
//   - Bearer <token>、sk- 前缀 key、20+ 位连续凭据片段必须被抹除；
//   - authorization / x-api-key / cookie 等键值对的值必须被抹除；
//   - 正常内容（URL、UUID、模型名）原样保留；
//   - 控制字符与 ANSI 转义沿用 logger 旧规则（日志注入防线不回退）。
// =============================================================================

import { describe, expect, it } from 'vitest';
import { sanitizeLog, sanitizeErrorDetail, stripDangerousNodeDebug } from '../src/utils/sanitize.js';

describe('sanitizeLog —— 凭据脱敏', () => {
  it('抹除 Bearer token（验收用例：日志捕获不得出现 "Bearer sk-"）', () => {
    const out = sanitizeLog('Authorization: Bearer sk-live-0123456789abcdef012345 failed with 401');
    expect(out).not.toMatch(/Bearer\s+sk/i);
    expect(out).not.toContain('sk-live-0123456789abcdef012345');
    expect(out).toContain('***REDACTED***');
    // 保留上下文便于排查
    expect(out).toContain('failed with 401');
  });

  it('抹除 sk- 前缀的 20+ 位 key 片段（不依赖 Bearer 前缀）', () => {
    const key = 'sk-0123456789abcdef0123456789';
    const out = sanitizeLog(`x-api-key ${key} rejected`);
    expect(out).not.toContain(key);
    expect(out).toMatch(/sk-\*\*\*REDACTED\*\*\*/);
  });

  it('抹除 20+/24+ 位无前缀的连续凭据片段（base64/hex key）', () => {
    const out = sanitizeLog('key ABCDEFGHIJKLMNOPQRSTUVWX012345 leaked');
    expect(out).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWX012345');
    expect(out).toContain('***REDACTED***');
  });

  it('抹除敏感头键值对（authorization/x-api-key/x-admin-token/cookie）', () => {
    const out = sanitizeLog(
      'req headers { "x-api-key": "sk-short123456", "cookie": "session=0123456789abcdef012345" }',
    );
    expect(out).not.toContain('sk-short123456');
    expect(out).not.toContain('session=0123456789abcdef012345');
  });

  it('抹除 api_key=/token= 查询参数形态', () => {
    const out = sanitizeLog('GET https://api.example.com/v1?api_key=0123456789abcdef012345&x=1');
    expect(out).not.toContain('0123456789abcdef012345');
    expect(out).toContain('api_key=***REDACTED***');
  });

  it('保留正常内容：URL、UUID、模型名、中文', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const line = `[REQUEST] POST /v1/chat/completions -> 200 (12ms) requestId=${uuid} model glm-5.2 用户会话`;
    expect(sanitizeLog(line)).toBe(line);
  });

  it('控制字符与 ANSI 转义序列被清除（沿用 logger 旧规则）', () => {
    const out = sanitizeLog('bad\u0007msg\u001B[31m red');
    expect(out).not.toContain('\u0007');
    expect(out).not.toContain('\u001B[31m');
    expect(out).toContain('badmsg red');
  });
});

describe('sanitizeErrorDetail —— 错误消息与堆栈', () => {
  it('message 与 stack 都过脱敏', () => {
    const err = new Error(`upstream rejected Bearer sk-0123456789abcdef0123456789`);
    const out = sanitizeErrorDetail(err);
    expect(out).not.toMatch(/sk-0123456789abcdef0123456789/);
    expect(out).toContain('upstream rejected');
  });

  it('非 Error 值不抛错', () => {
    expect(sanitizeErrorDetail(undefined)).toBe('');
    expect(sanitizeErrorDetail('plain string')).toContain('plain string');
  });
});

describe('stripDangerousNodeDebug —— 启动时剥离 undici/http 调试项', () => {
  it('剥离 undici/http 项并返回被剥离清单', () => {
    const env: NodeJS.ProcessEnv = { NODE_DEBUG: 'undici,http,fs' };
    const result = stripDangerousNodeDebug(env);
    expect(result.changed).toBe(true);
    expect(result.removed).toEqual(['undici', 'http']);
    expect(env.NODE_DEBUG).toBe('fs');
  });

  it('NODE_DEBUG=* 会开启 undici 原生调试（打印请求头），同样剥离', () => {
    const env: NodeJS.ProcessEnv = { NODE_DEBUG: '*' };
    const result = stripDangerousNodeDebug(env);
    expect(result.changed).toBe(true);
    expect(env.NODE_DEBUG).toBe('');
  });

  it('无危险项时不动', () => {
    const env: NodeJS.ProcessEnv = { NODE_DEBUG: 'fs,tls' };
    const result = stripDangerousNodeDebug(env);
    expect(result.changed).toBe(false);
    expect(env.NODE_DEBUG).toBe('fs,tls');
  });

  it('未设置 NODE_DEBUG 时不动', () => {
    expect(stripDangerousNodeDebug({}).changed).toBe(false);
  });
});
