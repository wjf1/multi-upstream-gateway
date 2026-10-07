// =============================================================================
// T208/T209 回归防线：多上游「上游」管理页 + 总览异常横幅
// -----------------------------------------------------------------------------
// 锁三件事：
// 1. 新 tab（upstream）具备与既有五页完全一致的 tablist/tab/tabpanel 语义，
//    且骨架分区带 data-route（hash 路由落点）；
// 2. upstream.js 的数据通路指向 T213 的 /api/providers（读）与
//    /api/providers/:name/{enable,disable}、/api/providers/default（写），
//    动态文本一律 esc，不引外链（CDN 本地化红线）；
// 3. 总览横幅 renderProviderBanner 的出现/消失条件（T213 DoD 最后一项的
//    前端面：health 异常出现、恢复消失）。
// 取证源：index.html + public/js/upstream.js（Phase E 同款平移，断言条件不改）。
// =============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
const upstreamJs = readFileSync(path.join(root, 'public', 'js', 'upstream.js'), 'utf-8');
const coreJs = readFileSync(path.join(root, 'public', 'js', 'core.js'), 'utf-8');

describe('上游管理页：tab 语义与骨架', () => {
  it('tab-upstream 具备 tab 语义并与 content-upstream 互相指向', () => {
    expect(html).toMatch(/id="tab-upstream" role="tab" aria-selected="(true|false)" aria-controls="content-upstream"/);
    expect(html).toMatch(/id="content-upstream" role="tabpanel" tabindex="0" aria-labelledby="tab-upstream"/);
  });

  it('分区带 data-route（hash 路由落点）且 aria-selected 初始为 false', () => {
    expect(html).toMatch(/id="content-upstream"[^>]*data-route="upstream"/);
    expect(html).toMatch(/id="tab-upstream"[^>]*aria-selected="false"/);
  });

  it('骨架容器齐备：providerCards / providerBanner(role=alert) / 刷新按钮', () => {
    expect(html).toContain('id="providerCards"');
    expect(html).toMatch(/id="providerBanner" role="alert"/);
    expect(html).toContain('onclick="refreshUpstream()"');
  });

  it('upstream.js 按序 defer 外链，页内无新增内联业务脚本', () => {
    expect(html).toContain('<script src="/js/upstream.js" defer></script>');
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(inline.length).toBe(1); // 仅剩 head 主题防闪屏 1 行
    expect(inline[0]).toContain('ccproxy-theme');
  });
});

describe('upstream.js：数据通路与安全红线', () => {
  it('读 GET /api/providers；写启停与默认上游走 T213 端点', () => {
    expect(upstreamJs).toContain("apiJson('/api/providers')");
    expect(upstreamJs).toContain("'/api/providers/' + encodeURIComponent(name) + '/' + (enable ? 'enable' : 'disable')");
    expect(upstreamJs).toContain("apiJson('/api/providers/default'");
  });

  it('enter_upstream / refreshUpstream / registerRefresh 接线齐备（core.js 约定）', () => {
    expect(upstreamJs).toContain('function enter_upstream()');
    expect(upstreamJs).toContain('function refreshUpstream()');
    expect(upstreamJs).toContain("registerRefresh('upstream', loadUpstream, 15000)");
    expect(upstreamJs).toContain("registerRefresh('*', refreshBannerQuiet, 15000)");
    // core.js 的进入钩子约定：window['enter_' + tab]
    expect(coreJs).toContain("window['enter_' + tab]");
  });

  it('动态文本一律 esc（XSS 红线），无外部 CDN 外链', () => {
    for (const s of ['esc(sc.state)', 'esc(p.displayName)', 'esc(String(p.initError)']) {
      expect(upstreamJs).toContain(s);
    }
    expect(upstreamJs).not.toMatch(/https?:\/\/cdn\.|https?:\/\/cdnjs\.cloudflare\.com|https?:\/\/cdn\.jsdelivr\.net/);
    expect(() => new Function(upstreamJs)).not.toThrow(); // 纯 JS（无 TS 语法）
  });
});

describe('总览异常横幅（T213 DoD：异常出现 / 恢复消失）', () => {
  it('renderProviderBanner 定义在 upstream.js 且挂在 window（跨页可用）', () => {
    expect(upstreamJs).toContain('window.renderProviderBanner = function');
  });

  it('出现条件 = 已配置 + 已初始化 + 已启用 + health 不健康；否则隐藏', () => {
    expect(upstreamJs).toContain('p.configured && p.initialized && p.enabled && p.health && p.health.healthy !== true');
    expect(upstreamJs).toContain("el.classList.add('hidden')");
    expect(upstreamJs).toContain("el.classList.remove('hidden')");
  });

  it('横幅内容含 sidecar 状态与初始化失败摘要（排障可用）', () => {
    expect(upstreamJs).toContain('sidecar ');
    expect(upstreamJs).toContain('初始化失败：');
  });
});
