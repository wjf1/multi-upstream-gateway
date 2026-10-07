// =============================================================================
// 合规风险告知门测试（T106 DoD，master-plan v1.2 §3.7-7）
// -----------------------------------------------------------------------------
// 覆盖：默认 false 判定、环境变量优先、/v1 未确认 403（OpenAI 与 Anthropic 两种
// 信封）、确认后放行并热生效、写回 config.json 保留其余字段、accept 端点的
// 管理面鉴权（无 x-admin-token → 401）。
// =============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let work: { dir: string; configFile: string; envFile: string };

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-gate-'));
  work = { dir, configFile: path.join(dir, 'config.json'), envFile: path.join(dir, '.env') };
  process.env.COMMANDCODE_CONFIG_PATH = work.configFile;
  process.env.COMMANDCODE_ENV_PATH = work.envFile;
  delete process.env.ACCEPTED_RISK_DISCLAIMER;
  delete process.env.PROXY_API_KEY;
  delete process.env.COMMANDCODE_ACCOUNTS_V1;
});

afterEach(() => {
  delete process.env.COMMANDCODE_CONFIG_PATH;
  delete process.env.COMMANDCODE_ENV_PATH;
  delete process.env.ACCEPTED_RISK_DISCLAIMER;
  delete process.env.PROXY_API_KEY;
  delete process.env.COMMANDCODE_ACCOUNTS_V1;
  fs.rmSync(work.dir, { recursive: true, force: true });
  vi.resetModules();
});

/** 动态 import：CONFIG_FILE_PATH 模块级求值，必须在 env 隔离之后加载。 */
async function freshRiskGate() {
  vi.resetModules();
  return import('../src/utils/risk-gate.js');
}

describe('判定优先级（ACCEPTED_RISK_DISCLAIMER > 内存 > 文件 > false）', () => {
  it('默认 false：配置缺失 / 字段缺失 / 非 true 值都视为未确认', async () => {
    const gate = await freshRiskGate();
    expect(gate.isRiskDisclaimerAccepted()).toBe(false); // 文件不存在

    fs.writeFileSync(work.configFile, JSON.stringify({ port: 9090 }), 'utf-8');
    const gate2 = await freshRiskGate();
    expect(gate2.isRiskDisclaimerAccepted()).toBe(false);

    fs.writeFileSync(work.configFile, JSON.stringify({ acceptedRiskDisclaimer: false }), 'utf-8');
    const gate3 = await freshRiskGate();
    expect(gate3.isRiskDisclaimerAccepted()).toBe(false);
  });

  it('config.json 顶层为 true 即视为已确认（unified 与旧扁平形态同位置）', async () => {
    fs.writeFileSync(
      work.configFile,
      JSON.stringify({ acceptedRiskDisclaimer: true, providers: { commandcode: {} } }),
      'utf-8',
    );
    const gate = await freshRiskGate();
    expect(gate.isRiskDisclaimerAccepted()).toBe(true);
  });

  it('ACCEPTED_RISK_DISCLAIMER 环境变量优先级最高（1/true 生效，其余不算）', async () => {
    fs.writeFileSync(work.configFile, JSON.stringify({ acceptedRiskDisclaimer: false }), 'utf-8');
    process.env.ACCEPTED_RISK_DISCLAIMER = '1';
    let gate = await freshRiskGate();
    expect(gate.isRiskDisclaimerAccepted()).toBe(true);

    process.env.ACCEPTED_RISK_DISCLAIMER = 'true';
    gate = await freshRiskGate();
    expect(gate.isRiskDisclaimerAccepted()).toBe(true);

    process.env.ACCEPTED_RISK_DISCLAIMER = '0';
    gate = await freshRiskGate();
    expect(gate.isRiskDisclaimerAccepted()).toBe(false);
  });

  it('配置文件损坏时不放行（fail-closed）', async () => {
    fs.writeFileSync(work.configFile, '{ this is not json', 'utf-8');
    const gate = await freshRiskGate();
    expect(gate.isRiskDisclaimerAccepted()).toBe(false);
  });
});

describe('acceptRiskDisclaimer（写回 + 热生效）', () => {
  it('写回 config.json 且保留其余字段与未知键', async () => {
    fs.writeFileSync(
      work.configFile,
      JSON.stringify({
        port: 9191,
        acceptedRiskDisclaimer: false,
        providers: { commandcode: { rotationMode: 'auto-quota' } },
        customKept: 'yes',
      }),
      'utf-8',
    );
    const gate = await freshRiskGate();
    expect(gate.isRiskDisclaimerAccepted()).toBe(false);

    gate.acceptRiskDisclaimer();
    // 热生效：同进程内立即为 true
    expect(gate.isRiskDisclaimerAccepted()).toBe(true);

    const written = JSON.parse(fs.readFileSync(work.configFile, 'utf-8'));
    expect(written.acceptedRiskDisclaimer).toBe(true);
    expect(written.port).toBe(9191);
    expect(written.providers.commandcode.rotationMode).toBe('auto-quota');
    expect(written.customKept).toBe('yes'); // 未知键保留
  });

  it('配置文件不存在时也能确认（创建新文件）', async () => {
    const gate = await freshRiskGate();
    gate.acceptRiskDisclaimer();
    const written = JSON.parse(fs.readFileSync(work.configFile, 'utf-8'));
    expect(written.acceptedRiskDisclaimer).toBe(true);
  });
});

// ─── HTTP 层：403 拦截与放行 ─────────────────────────────────────────────────

/** 构造一个只挂安全链 + 风险门 + 一条最小 /v1 路由的 Fastify 实例。 */
async function buildApp(withRiskAccepted: boolean) {
  if (withRiskAccepted) {
    fs.writeFileSync(work.configFile, JSON.stringify({ acceptedRiskDisclaimer: true }), 'utf-8');
  } else {
    fs.writeFileSync(work.configFile, JSON.stringify({ acceptedRiskDisclaimer: false }), 'utf-8');
  }
  vi.resetModules();
  const Fastify = (await import('fastify')).default;
  const { registerRiskGate } = await import('../src/utils/risk-gate.js');
  const { ErrorCode } = await import('../src/utils/errors.js');
  const app = Fastify({ logger: false });
  registerRiskGate(app);
  app.post('/v1/chat/completions', async () => ({ ok: true }));
  app.post('/v1/messages', async () => ({ ok: true }));
  app.get('/api/status', async () => ({ acceptedRiskDisclaimer: false }));
  await app.ready();
  return { app, ErrorCode };
}

describe('/v1 风险门（HTTP 层）', () => {
  it('未确认：/v1/chat/completions 403 + RISK_DISCLAIMER_NOT_ACCEPTED（OpenAI 信封）', async () => {
    const { app, ErrorCode } = await buildApp(false);
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { messages: [] } });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe(ErrorCode.RISK_DISCLAIMER_NOT_ACCEPTED);
    expect(body.error.type).toBe('permission_error');
    await app.close();
  });

  it('未确认：/v1/messages 403（Anthropic 信封）', async () => {
    const { app, ErrorCode } = await buildApp(false);
    const res = await app.inject({ method: 'POST', url: '/v1/messages', payload: { messages: [] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(ErrorCode.RISK_DISCLAIMER_NOT_ACCEPTED);
    expect(res.json().type).toBe('error');
    await app.close();
  });

  it('未确认时 /api/* 不受影响（风险门只管数据面）', async () => {
    const { app } = await buildApp(false);
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('确认后放行（且热生效：同进程内 accept 后立即 200）', async () => {
    const { app } = await buildApp(false);
    const before = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { messages: [] } });
    expect(before.statusCode).toBe(403);

    const gate = await import('../src/utils/risk-gate.js');
    gate.acceptRiskDisclaimer();

    const after = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { messages: [] } });
    expect(after.statusCode).toBe(200);
    await app.close();
  });

  it('已确认（配置文件 true）时直接放行', async () => {
    const { app } = await buildApp(true);
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { messages: [] } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('OPTIONS 预检放行（不携带自定义头，也不产生实际调用）', async () => {
    const { app } = await buildApp(false);
    const res = await app.inject({ method: 'OPTIONS', url: '/v1/chat/completions' });
    expect(res.statusCode).not.toBe(403);
    await app.close();
  });
});

// ─── accept 端点的管理面鉴权 ─────────────────────────────────────────────────

describe('POST /api/risk/accept 的管理面鉴权', () => {
  it('无 x-admin-token → 401；带正确 token → 200 且写回', async () => {
    fs.writeFileSync(work.configFile, JSON.stringify({ acceptedRiskDisclaimer: false }), 'utf-8');
    process.env.ADMIN_API_TOKEN = 'risk-test-token';
    vi.resetModules();
    const Fastify = (await import('fastify')).default;
    const { adminTokenOk } = await import('../src/utils/admin-guard.js');
    const { acceptRiskDisclaimer } = await import('../src/utils/risk-gate.js');

    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (req: any, reply: any) => {
      if (req.url.startsWith('/api/') && !['GET', 'OPTIONS', 'HEAD'].includes(req.method)) {
        if (!adminTokenOk(req.headers['x-admin-token'])) return reply.status(401).send({ error: 'no token' });
      }
    });
    app.post('/api/risk/accept', async () => {
      acceptRiskDisclaimer();
      return { status: 'success', acceptedRiskDisclaimer: true };
    });
    await app.ready();

    const denied = await app.inject({ method: 'POST', url: '/api/risk/accept' });
    expect(denied.statusCode).toBe(401);
    expect(JSON.parse(fs.readFileSync(work.configFile, 'utf-8')).acceptedRiskDisclaimer).toBe(false);

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/risk/accept',
      headers: { 'x-admin-token': 'risk-test-token' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(JSON.parse(fs.readFileSync(work.configFile, 'utf-8')).acceptedRiskDisclaimer).toBe(true);
    await app.close();
    delete process.env.ADMIN_API_TOKEN;
  });
});
