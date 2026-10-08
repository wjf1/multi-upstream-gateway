// =============================================================================
// F07 回归防线：WorkBuddy 账号池可视化 · 积分条（面板接线）
// -----------------------------------------------------------------------------
// 背景：T302 只交付了后端（`data/state.json` 持久化 + `GET /api/upstreams/workbuddy/balance`
// 只读镜像 + `POST /api/upstreams/workbuddy/balance/refresh`），面板一直没有渲染，
// 于是「积分条」在 F07 里一直是 ⛔。本文件锁三件事：
// 1. 数据通路：accounts.js 只读消费 `/api/upstreams/workbuddy/balance`，刷新按钮走
//    `/api/upstreams/workbuddy/balance/refresh`（POST）—— 与 T302 路由逐字一致；
// 2. 两条语义红线：
//    - **未知 ≠ 0**：`credits`/`creditsTotal` 缺失时不画进度条，也不能把 undefined 当 0
//      算成「已用光」；`creditsTotal <= 0` 同理（无总额度算不出百分比）；
//    - **degraded 必须显式标红**：镜像不可信（从未成功/连续失败/损坏未重建）时不能把
//      这批数字当实时余额展示；
// 3. 池状态三态（暂停/停用/冷却）与「待刷新」共存于账号池视图，动态文本一律 esc。
// 取证源：public/js/accounts.js（Phase E 同款静态断言，不引浏览器）。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const accountsJs = readFileSync(path.join(root, 'public', 'js', 'accounts.js'), 'utf-8');
const coreJs = readFileSync(path.join(root, 'public', 'js', 'core.js'), 'utf-8');

/** 按大括号配平取出一个顶层 `function name(...) { ... }` 源码（同 spa-search-functions）。 */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in panel source`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** 取出单行的 `const NAME = ...;` 声明（core.js 的 esc 是箭头函数，不是 function 声明）。 */
function extractArrowConst(src: string, name: string): string {
  const line = src.split('\n').map(l => l.trim()).find(l => l.startsWith(`const ${name} =`));
  if (!line) throw new Error(`const ${name} not found in panel source`);
  return line;
}

/**
 * 把 accounts.js 里的积分条渲染链（formatCredits → creditsBar / poolStateBadges →
 * workbuddyBalancePanel）作为**真实源码**求值，避免测试与页面各说一套。
 * `badge` 用桩（真实版依赖 core.js 的 BADGE_TONES，与本次断言无关），`esc` 用真身。
 */
function loadBalanceRenderer() {
  const names = ['formatCredits', 'creditsBar', 'poolStateBadges', 'workbuddyBalancePanel'];
  const body = names.map(n => extractFn(accountsJs, n)).join('\n');
  const esc = new Function(`${extractArrowConst(coreJs, 'esc')}; return esc;`)() as (s: unknown) => string;
  const badge = (text: string, tone: string) => `{{${text}:${tone}}}`;
  return new Function('esc', 'badge', 'wbBalanceBusy',
    `${body}; return { workbuddyBalancePanel, creditsBar, formatCredits };`)(
    esc, badge, false,
  ) as {
    workbuddyBalancePanel: (s: unknown) => string;
    creditsBar: (e: Record<string, unknown>) => string;
    formatCredits: (v: unknown) => string;
  };
}

const { workbuddyBalancePanel, creditsBar } = loadBalanceRenderer();
const entry = (over: Record<string, unknown> = {}) =>
  ({ uid: 'u1', paused: false, disabled: false, cooling: false, sampledAt: 1, ...over });
const snap = (over: Record<string, unknown> = {}) =>
  ({ refreshedAt: 1, persistedAt: 1, intervalMs: 300000, nextRefreshAt: 2, consecutiveFailures: 0, degraded: false, accounts: [entry()], ...over });

describe('F07 WorkBuddy 积分条：数据通路', () => {
  it('只读镜像消费 GET /api/upstreams/workbuddy/balance', () => {
    expect(accountsJs).toMatch(/apiJson\('\/api\/upstreams\/workbuddy\/balance'\)/);
  });

  it('刷新按钮走 POST /api/upstreams/workbuddy/balance/refresh（与 T302 路由一致）', () => {
    expect(accountsJs).toMatch(/data-wb-action="refresh-balance"/);
    expect(accountsJs).toMatch(/apiJson\('\/api\/upstreams\/workbuddy\/balance\/refresh',\s*\{\s*method:\s*'POST'/);
  });

  it('刷新通过既有事件委托绑定（不新增内联 onclick / 不新增静态 id 引用）', () => {
    expect(accountsJs).toMatch(/btn\.dataset\.wbAction === 'refresh-balance'/);
    // 面板回归测试要求 getElementById 的 id 在 index.html 里静态存在；本卡一律走委托，
    // 故 accounts.js 里除既有容器外不应新增 getElementById（用 0 个新增举证）。
    const ids = [...accountsJs.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
    expect(ids).not.toContain('wbBalanceRefresh');
  });
});

describe('F07 WorkBuddy 积分条：渲染语义', () => {
  it('渲染函数与积分条容器齐备（role=progressbar）', () => {
    expect(accountsJs).toMatch(/function\s+workbuddyBalancePanel\s*\(/);
    expect(accountsJs).toMatch(/role="progressbar"/);
    expect(accountsJs).toMatch(/aria-valuenow="/);
  });

  it('未知 ≠ 0：credits / creditsTotal 非数值（或总额度<=0）时不画进度条', () => {
    // 分支必须真的按类型判断，而不是 `credits || 0` 这类把未知吞成 0 的写法。
    expect(accountsJs).toMatch(/typeof\s+credits\s*!==\s*'number'/);
    expect(accountsJs).toMatch(/typeof\s+creditsTotal\s*!==\s*'number'/);
    expect(accountsJs).toMatch(/creditsTotal\s*<=\s*0/);
    expect(accountsJs).not.toMatch(/credits\s*\|\|\s*0/);
  });

  it('degraded 显式标红并带上 degradedReason', () => {
    expect(accountsJs).toMatch(/snapshot\.degraded\s*===\s*true/);
    expect(accountsJs).toMatch(/snapshot\.degradedReason/);
    expect(accountsJs).toMatch(/积分镜像不可信/);
  });

  it('池状态三态（暂停/停用/冷却中）与即将过期积分都有落点', () => {
    expect(accountsJs).toMatch(/entry\.paused\s*\)/);
    expect(accountsJs).toMatch(/entry\.disabled\s*\)/);
    expect(accountsJs).toMatch(/entry\.cooling\s*\)/);
    expect(accountsJs).toMatch(/暂停/);
    expect(accountsJs).toMatch(/停用/);
    expect(accountsJs).toMatch(/冷却中/);
    expect(accountsJs).toMatch(/creditsExpiring/);
  });

  it('动态文本一律 esc（昵称/uid/原因都不裸拼）', () => {
    expect(accountsJs).toMatch(/esc\(formatCredits\(/);
    expect(accountsJs).toMatch(/esc\(snapshot\.degradedReason/);
    expect(accountsJs).toMatch(/esc\(title\)/);
  });

  it('accounts.js 仍可作为纯 JavaScript 解析（面板禁止 TS 语法）', () => {
    expect(() => new Function(accountsJs)).not.toThrow();
  });
});

// 上面是对源码的静态断言；这里直接跑渲染函数，把「未知 ≠ 0」「degraded 标红」等
// 语义红线变成可执行断言 —— 静态正则改不动行为，运行时断言可以。
describe('F07 WorkBuddy 积分条：渲染行为（真跑函数）', () => {
  it('未知 ≠ 0：credits 缺失时不给进度条，也不把余量写成 0', () => {
    const out = creditsBar({ credits: undefined, creditsTotal: 100 } as Record<string, unknown>);
    expect(out).not.toContain('progressbar');
    expect(out).toContain('—');
  });

  it('未知 ≠ 0：creditsTotal 为 0 / 缺失时同样不给进度条（算不出百分比）', () => {
    expect(creditsBar({ credits: 0, creditsTotal: 0 })).not.toContain('progressbar');
    expect(creditsBar({ credits: 0 } as Record<string, unknown>)).not.toContain('progressbar');
  });

  it('正常余量：进度条按 credits/creditsTotal 出百分比与 aria-valuenow', () => {
    const out = creditsBar({ credits: 25, creditsTotal: 100 });
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="25"');
    expect(out).toContain('25%');
    expect(out).toContain('25');
  });

  it('degraded 快照：显式标红并带上原因，且原因被转义', () => {
    const out = workbuddyBalancePanel(snap({ degraded: true, degradedReason: '<img src=x>', consecutiveFailures: 3 }));
    expect(out).toContain('积分镜像不可信');
    expect(out).toContain('&lt;img src=x&gt;');
    expect(out).not.toContain('<img src=x>');
  });

  it('池状态三态各自出徽章，未置位的账号不出徽章', () => {
    const out = workbuddyBalancePanel(snap({ accounts: [
      entry({ uid: 'a', paused: true }),
      entry({ uid: 'b', disabled: true }),
      entry({ uid: 'c', cooling: true }),
      entry({ uid: 'd' }),
    ] }));
    expect(out).toContain('{{暂停:amber}}');
    expect(out).toContain('{{停用:rose}}');
    expect(out).toContain('{{冷却中:slate}}');
    expect((out.match(/\{\{/g) || []).length).toBe(3); // 第 4 个账号无徽章
  });

  it('即将过期积分单列一行（含最早过期日）', () => {
    const out = creditsBar(entry({ credits: 50, creditsTotal: 100, creditsExpiring: 12, earliestExpiry: 4102444800000 }));
    expect(out).toContain('即将过期');
    expect(out).toContain('12');
  });

  it('空池与非法入参：给空态文案而不是崩溃', () => {
    expect(workbuddyBalancePanel(snap({ accounts: [] }))).toContain('池内暂无账号');
    expect(workbuddyBalancePanel(null)).toBe('');
    expect(workbuddyBalancePanel({ accounts: 'nope' })).toBe('');
  });

  it('账号昵称被转义（昵称来自 sidecar，不能直接进 innerHTML）', () => {
    const out = workbuddyBalancePanel(snap({ accounts: [entry({ nickname: '<script>x</script>' })] }));
    expect(out).not.toContain('<script>x</script>');
    expect(out).toContain('&lt;script&gt;');
  });
});
