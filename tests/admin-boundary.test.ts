// =============================================================================
// 批次 B：鉴权边界（B1 管理面 token / B2 Host 回环白名单 / B3 非回环拒绝启动 /
// B4 OAuth state / B5 不含 script-src 的 CSP）。
// -----------------------------------------------------------------------------
// 这一批的根因是同一个：**管理面默认零鉴权，而唯一的跨站防线读的是攻击者可控的
// Host 头**。DNS rebinding 把 evil.tld 解析到 127.0.0.1 后，Origin 与 Host 天然
// 相等，旧的 isSameOriginIfPresent 必然放行。所以 B2 是 B1 的前提：不先把页面
// 和 token 的投递关进回环白名单，注入到 HTML 里的 token 会被攻击者一并读走。
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  ADMIN_TOKEN,
  adminTokenOk,
  isLoopbackHostHeader,
  isInsecureBind,
  oauthStateAcceptable,
} from '../src/utils/admin-guard.js';
import { dashboardRoutes } from '../src/routes/dashboard.js';
import { verifyProxyAuth } from '../src/routes/chat.js';

let stateDir: string;
let app: FastifyInstance;

const LOOPBACK_HOST = '127.0.0.1:9090';
/** rebinding 场景下浏览器会带上与 Host 自洽的 Origin —— 旧防线正是被这一对骗过的。 */
const REBOUND_HOST = 'evil.tld:9090';

const post = (
  url: string,
  headers: Record<string, string>,
  body: unknown = {},
) => app.inject({ method: 'POST', url, headers: { host: LOOPBACK_HOST, ...headers }, body: JSON.stringify(body) });

beforeAll(async () => {
  // 写操作正例真的会走 handler 并保存配置：状态文件必须隔离，否则 .env / config.json
  // 会落到仓库根（.env 里的 COMMANDCODE_API_BASE 优先级高于 config.json）。
  stateDir = mkdtempSync(path.join(tmpdir(), 'ccproxy-boundary-'));
  process.env.COMMANDCODE_CONFIG_PATH = path.join(stateDir, 'config.json');
  process.env.COMMANDCODE_ENV_FILE_PATH = path.join(stateDir, '.env');
  process.env.COMMANDCODE_MODELS_CACHE_PATH = path.join(stateDir, 'models.json');
  process.env.COMMANDCODE_PRICING_CACHE_PATH = path.join(stateDir, 'pricing.json');
  process.env.USAGE_HISTORY_PATH = path.join(stateDir, 'usage.jsonl');
  // 本文件的写操作正例真的会停一次引擎，而引擎暂停会发桌面通知 —— 通知路径在 Windows 上
  // 同步读注册表/起 PowerShell（见 notifier.ts 的 timeout 说明），在 CI runner 上实测卡 10s+
  // 把用例拖成超时判红。这里测的是鉴权边界，不是通知，故整体关掉（notify() 首行即返回 false）。
  process.env.COMMANDCODE_NOTIFY = '0';

  app = Fastify();
  await app.register(dashboardRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('B2 isLoopbackHostHeader —— 回环名白名单', () => {
  it('接受回环名，端口随意', () => {
    expect(isLoopbackHostHeader('127.0.0.1:9090')).toBe(true);
    expect(isLoopbackHostHeader('localhost:9090')).toBe(true);
    expect(isLoopbackHostHeader('LOCALHOST')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:9090')).toBe(true);
    expect(isLoopbackHostHeader('127.0.0.1')).toBe(true);
  });

  it('拒绝外部域名、裸 IP 与被污染的 Host，包括 rebinding 的那个 evil.tld', () => {
    expect(isLoopbackHostHeader(REBOUND_HOST)).toBe(false);
    expect(isLoopbackHostHeader('attacker.example')).toBe(false);
    expect(isLoopbackHostHeader('10.0.0.5:9090')).toBe(false);
    expect(isLoopbackHostHeader('127.0.0.1.evil.tld')).toBe(false);
    // 端口分隔符之后的凭据/路径注入不接受
    expect(isLoopbackHostHeader('127.0.0.1:9090@evil.tld')).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
    expect(isLoopbackHostHeader('')).toBe(false);
  });

  it('ADMIN_ALLOWED_HOSTS 追加的名字生效（LAN 自托管场景）', () => {
    expect(isLoopbackHostHeader('gw.lan:9090')).toBe(false);
    expect(isLoopbackHostHeader('gw.lan:9090', 'gw.lan')).toBe(true);
    expect(isLoopbackHostHeader('gw.lan:9090', 'other.lan')).toBe(false);
  });
});

describe('B1 adminTokenOk —— 常量时间比较', () => {
  it('只对完全一致的 token 为真', () => {
    expect(adminTokenOk(ADMIN_TOKEN)).toBe(true);
    expect(adminTokenOk(undefined)).toBe(false);
    expect(adminTokenOk('')).toBe(false);
    expect(adminTokenOk(ADMIN_TOKEN.slice(0, -1))).toBe(false);
    expect(adminTokenOk(ADMIN_TOKEN + 'x')).toBe(false);
  });
});

describe('B4 oauthStateAcceptable', () => {
  const expected = randomUUID();
  it('state 一致才通过；缺失在默认下拒绝，旧版兼容开关打开才放行', () => {
    expect(oauthStateAcceptable(expected, expected, false)).toBe(true);
    expect(oauthStateAcceptable('other', expected, false)).toBe(false);
    expect(oauthStateAcceptable(null, expected, false)).toBe(false);
    expect(oauthStateAcceptable(null, expected, true)).toBe(true);
  });
});

describe('B3 isInsecureBind', () => {
  it('非回环绑定 + 无密钥 = 拒绝启动；回环或有密钥或显式逃生阀则放行', () => {
    expect(isInsecureBind({ host: '0.0.0.0', hasProxyKey: false, allowInsecure: false })).toBe(true);
    expect(isInsecureBind({ host: '192.168.1.7', hasProxyKey: false, allowInsecure: false })).toBe(true);
    expect(isInsecureBind({ host: '0.0.0.0', hasProxyKey: true, allowInsecure: false })).toBe(false);
    expect(isInsecureBind({ host: '0.0.0.0', hasProxyKey: false, allowInsecure: true })).toBe(false);
    expect(isInsecureBind({ host: '127.0.0.1', hasProxyKey: false, allowInsecure: false })).toBe(false);
    expect(isInsecureBind({ host: 'localhost', hasProxyKey: false, allowInsecure: false })).toBe(false);
  });
});

describe('B1/B2 端到端：管理面写操作的 token 门与 Host 门', () => {
  it('缺 x-admin-token 的管理面写请求 → 401', async () => {
    const res = await post('/api/gateway/toggle', { origin: `http://${LOOPBACK_HOST}` }, { running: false });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/token/i);
  });

  it('带正确 token 的同一请求不再被鉴权层拦下', async () => {
    const res = await post('/api/gateway/toggle', {
      origin: `http://${LOOPBACK_HOST}`,
      'x-admin-token': ADMIN_TOKEN,
    }, { running: false });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it('rebinding（Host 与 Origin 自洽的外链）→ 403，且这条优先于 token 检查', async () => {
    const res = await post('/api/gateway/toggle', {
      host: REBOUND_HOST,
      origin: `http://${REBOUND_HOST}`,
      'x-admin-token': ADMIN_TOKEN,
    }, { running: false });
    expect(res.statusCode).toBe(403);
  });

  it('只卡写：GET /api/status 不带 token 依然可读', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status', headers: { host: LOOPBACK_HOST } });
    expect(res.statusCode).toBe(200);
  });

  it('PROXY_API_KEY 不再是管理面凭据（权限分离）', async () => {
    const origNotify = process.env.COMMANDCODE_NOTIFY;
    process.env.COMMANDCODE_NOTIFY = '0';
    const key = `k-${randomUUID()}`;
    process.env.PROXY_API_KEY = key;
    const keyed = Fastify();
    verifyProxyAuth(keyed);
    await keyed.register(dashboardRoutes);
    await keyed.ready();
    try {
      const res = await keyed.inject({
        method: 'POST',
        url: '/api/gateway/toggle',
        headers: {
          host: LOOPBACK_HOST,
          origin: `http://${LOOPBACK_HOST}`,
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ running: false }),
      });
      expect(res.statusCode).toBe(401);
      // 但这把密钥仍然管得住 /v1（数据面不受本次改动影响）。
      expect(await keyed.inject({
        method: 'POST',
        url: '/api/gateway/toggle',
        headers: {
          host: LOOPBACK_HOST,
          origin: `http://${LOOPBACK_HOST}`,
          'x-admin-token': ADMIN_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ running: false }),
      }).then(r => r.statusCode)).not.toBe(401);
    } finally {
      await keyed.close();
      delete process.env.PROXY_API_KEY;
      if (origNotify === undefined) delete process.env.COMMANDCODE_NOTIFY;
      else process.env.COMMANDCODE_NOTIFY = origNotify;
    }
  }, 30000);
});

describe('B2/B5 GET / 的投递面', () => {
  it('回环 Host 下的页面带 token meta，且 CSP 不含 script-src（内联脚本还在用）', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: LOOPBACK_HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ccproxy-admin-token');
    expect(res.body).toContain(ADMIN_TOKEN);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toMatch(/frame-ancestors\s+'none'/);
    expect(csp).toMatch(/base-uri\s+'self'/);
    expect(csp).toMatch(/form-action\s+'self'/);
    expect(csp).not.toMatch(/script-src/);
  });

  it('外连 Host 打管理页 → 403，页面与 token 都不投递', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { host: REBOUND_HOST } });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(ADMIN_TOKEN);
  });
});

describe('B3 非回环绑定且无密钥时拒绝启动（真实 spawn 编译产物）', () => {
  const distEntry = path.resolve(__dirname, '..', 'dist', 'index.js');

  /** Windows 上进程刚退掉时临时目录仍被占用（日志句柄未释放），必须带退避重试。 */
  async function rmDirRetry(dir: string): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 150));
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }

  /**
   * 启动一个真实编译产物并收集控制台输出。
   *
   * `ready` 谓词决定"何时认为启动完成、可以 SIGKILL"。默认是横幅首行 `is ACTIVE`，
   * 但**要断言更靠后的输出时不能用它**：横幅是逐行写的，看到首行就杀进程会和
   * 剩余行的管道投递赛跑（覆盖率插桩下尤其明显——本项目实测过一次偶发失败）。
   * 需要断言 token 行之类的用例请传入更靠后的谓词。
   */
  async function boot(env: Record<string, string>, ready: (out: string) => boolean = o => o.includes('is ACTIVE')) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ccproxy-bind-'));
    const proc = spawn(process.execPath, [distEntry], {
      cwd: dir,
      env: {
        ...process.env,
        HOST: '0.0.0.0',
        PORT: '0',
        NO_OPEN_BROWSER: '1',
        COMMANDCODE_CONFIG_PATH: path.join(dir, 'config.json'),
        COMMANDCODE_ENV_FILE_PATH: path.join(dir, '.env'),
        COMMANDCODE_MODELS_CACHE_PATH: path.join(dir, 'models.json'),
        COMMANDCODE_PRICING_CACHE_PATH: path.join(dir, 'pricing.json'),
        USAGE_HISTORY_PATH: path.join(dir, 'usage.jsonl'),
        // T103 启动守卫的隔离：本用例验证的是 B3（非回环拒启），不能被凭据加密检查
        // 抢先拦住。父进程（同 worker）import config.js 时会把仓库根 .env 读进
        // process.env，故这里显式清空明文凭据来源与加密库路径。
        COMMANDCODE_ACCOUNTS_V1: '',
        CREDENTIAL_STORE_PATH: path.join(dir, 'credentials.enc'),
        CREDENTIAL_ENCRYPTION_KEY: '',
        PROXY_API_KEY: '',
        ALLOW_INSECURE_BIND: '',
        ADMIN_API_TOKEN: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.stderr.on('data', d => { out += String(d); });

    const exited = new Promise<void>(resolve => { proc.on('exit', () => resolve()); });
    // 起来了就一直听着：见到 ACTIVE 横幅立刻 SIGKILL 并以 -1 回报，避免空等 20s。
    const outcome = await new Promise<{ code: number | null; out: string }>(resolve => {
      let settled = false;
      let killed = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ code, out });
      };
      const poll = setInterval(() => {
        if (ready(out)) {
          killed = true;
          proc.kill('SIGKILL');
          finish(-1);
        }
      }, 100);
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
        finish(-1);
      }, 60000);
      proc.on('exit', code => finish(killed ? -1 : code));
    });
    await exited;
    await rmDirRetry(dir);
    return outcome;
  }

  it('前置：构建产物存在（否则本文件这几项毫无意义）', () => {
    expect(existsSync(distEntry)).toBe(true);
  });

  it('HOST=0.0.0.0 且无密钥 → 退出码非 0 并打印原因', async () => {
    // 这条走的是"进程自己退出"路径（不是被 SIGKILL），所以 code 必须是真实退出码。
    // 上限放宽到 90s：覆盖率插桩 + 4.22.4 的代理探针初始化会显著拖慢启动。
    const r = await boot({});
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBe(-1);
    expect(r.out).toMatch(/拒绝启动/);
    expect(r.out).toMatch(/ALLOW_INSECURE_BIND/);
  }, 90000);

  it('显式 ALLOW_INSECURE_BIND=1 时照常启动，并把管理 token 打到控制台', async () => {
    const pinned = `pinned-${randomUUID()}`;
    // 断言的是 token 行，而它排在横幅首行 `is ACTIVE` **之后**——必须等到该行真正
    // 到达管道再收工，否则 SIGKILL 会与剩余行的投递赛跑（偶发失败）。
    const r = await boot(
      { ALLOW_INSECURE_BIND: '1', ADMIN_API_TOKEN: pinned },
      out => out.includes('is ACTIVE') && out.includes('Admin token'),
    );
    expect(r.code).toBe(-1); // 没退出 = 一直在听，被我们 SIGKILL
    expect(r.out).toMatch(/is ACTIVE/);
    expect(r.out).toContain(pinned);
  }, 90000);
});
