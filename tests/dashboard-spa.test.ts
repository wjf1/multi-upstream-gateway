import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
// T110：面板脚本已从 index.html 外置到 public/js/*.js（页面只留骨架 + 6 个 defer
// 外链）。凡是从"页面源码"取函数/元素 id 的断言，取证源改为 index.html 与 6 个
// 页面脚本的合并源码；针对标记本身的断言仍读 index.html。断言条件与正则逐字不变。
const PANEL_JS_FILES = ['core', 'overview', 'accounts', 'usage', 'models', 'logs'];
const panelJsSources = PANEL_JS_FILES.map(f => readFileSync(path.join(root, 'public', 'js', f + '.js'), 'utf-8'));
const src = html + '\n' + panelJsSources.join('\n');

// 仪表盘 SPA 是纯 JavaScript（不经编译直接进浏览器）。历史上混入过 TypeScript
// 的 `as` 断言导致整个脚本块在浏览器里 SyntaxError——用本测试锁死：
// 内联脚本与全部外置页面脚本必须都能作为纯 JavaScript 解析。
describe('dashboard SPA (public/index.html + public/js/*.js)', () => {
  it('inline script parses as plain JavaScript (no TypeScript syntax)', () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).concat(panelJsSources);
    expect(scripts.length).toBeGreaterThan(0);
    for (const code of scripts) {
      expect(() => new Function(code)).not.toThrow();
    }
  });

  it('every statically referenced element id exists in the HTML', () => {
    const referenced = new Set(
      [...src.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]),
    );
    const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    const missing = [...referenced].filter(id => !defined.has(id));
    expect(missing).toEqual([]);
  });

  it('every onclick handler references a function defined in the script', () => {
    const onclicks = new Set(
      [...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]),
    );
    expect(onclicks.size).toBeGreaterThan(0);
    const missing = [...onclicks].filter(fn => !new RegExp('function\\s+' + fn + '\\b').test(src));
    expect(missing).toEqual([]);
  });

  it('does not reference external CDNs (assets are localized)', () => {
    for (const s of [html, ...panelJsSources]) {
      expect(s).not.toMatch(/https?:\/\/cdn\.|https?:\/\/cdnjs\.cloudflare\.com|https?:\/\/cdn\.jsdelivr\.net/);
    }
  });

  // 模型卡片必须能把 GO 与 GOAT 两个档位分开标注：只看 onGoPlan 会让
  // GOAT-only 的模型（如 gpt-5.6-sol）显示成没有档位区别的「可用」。
  it('renders both GO and GOAT plan badges from the per-plan availability map', () => {
    expect(html).toMatch(/data-tag="goat"/);
    expect(src).toMatch(/isPlanOn\(m, 'individual-go'\)/);
    expect(src).toMatch(/isPlanOn\(m, 'individual-goat'\)/);
    expect(src).toMatch(/planPill\('individual-go'/);
    expect(src).toMatch(/planPill\('individual-goat'/);
    expect(src).not.toMatch(/if \(m\.onGoPlan\) tags \+=/);
  });

  // 性能面板必须按「吞吐样本」渲染，而不是笼统的 samples：输出过短的响应会让
  // tok/s 的分母趋零（19ms / 3 token ≈ 187 t/s），据此算出的 P50/P95 是假的。
  it('perf table renders the throughput sample count and gates short outputs', () => {
    expect(src).toMatch(/r\.throughputSamples/);
    expect(src).toMatch(/仅计输出 ≥32 token/);
  });
});
