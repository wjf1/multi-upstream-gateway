// =============================================================================
// 真机探针：用**真实 Go 二进制**走网关的 sidecar 启动代码路径
// -----------------------------------------------------------------------------
// 单元测试全用假 sidecar，曾因此漏掉真实 CLI 契约（二进制只认 `-config`）。本探针把
// 「配置落盘 → spawn 真实进程 → 探活」这三步在真机上跑一遍，用于 T310/OAuth 演练前的
// 环境自检。它只操作自己的子进程与临时状态目录，不碰既有常驻服务。
//
//   npx tsx scripts/probe-workbuddy-live.ts <sidecar.exe> [port]
// =============================================================================
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkBuddyProvider } from '../src/providers/workbuddy/provider.js';

const bin = process.argv[2];
const port = Number.parseInt(process.argv[3] ?? '8788', 10);
if (!bin) {
  console.error('用法: npx tsx scripts/probe-workbuddy-live.ts <sidecar.exe> [port]');
  process.exit(2);
}

const stateDir = mkdtempSync(path.join(tmpdir(), 'wb-live-'));
const provider = new WorkBuddyProvider({
  env: {
    WORKBUDDY_SIDECAR_BIN: bin,
    WORKBUDDY_SIDECAR_PORT: String(port),
    COMMANDCODE_STATE_PATH: path.join(stateDir, 'state.json'),
  },
});

const line = (label: string, value: unknown): void =>
  console.log(`${label.padEnd(22)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);

try {
  line('[1] 拉起 sidecar', '...');
  await provider.initialize({ enabled: true });

  const st = provider.sidecarStatus();
  line('[2] 进程状态', st);

  const cfgPath = path.join(stateDir, 'workbuddy-sidecar', 'config.json');
  line('[3] 落盘配置', JSON.parse(readFileSync(cfgPath, 'utf8')));

  line('[4] 探活 /healthz', await (await fetch(`http://127.0.0.1:${port}/healthz`)).text());
  const status = await fetch(`http://127.0.0.1:${port}/status`);
  line('[5] /status HTTP', status.status);
  line('[6] 网关 health()', await provider.health());
} finally {
  await provider.destroy();
  line('[7] 已停止子进程', 'ok');
  rmSync(stateDir, { recursive: true, force: true });
}
