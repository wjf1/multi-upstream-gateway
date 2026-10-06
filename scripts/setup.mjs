#!/usr/bin/env node
// =============================================================================
// 启动向导（T106，master-plan v1.2 §3.7-9）
// -----------------------------------------------------------------------------
// 把"首次跑通"从「翻文档配 6 处」降为「一条命令」：
//   1. 生成/复用三个密钥（CREDENTIAL_ENCRYPTION_KEY / PROXY_API_KEY / ADMIN_API_TOKEN）
//   2. 写入 .env（默认，已在 .gitignore）或仅打印供系统级设置
//   3. 生成最小 config.json（不存在时）
//   4. 展示合规风险告知并询问确认（拒绝则不写 acceptedRiskDisclaimer）
//   5. 打印下一步
//
// 幂等：可反复执行——已存在的密钥/配置不会被覆盖，只补齐缺失项。
// 非交互（管道/CI）时全部走默认值，便于脚本化。
// =============================================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const ENV_PATH = process.env.COMMANDCODE_ENV_PATH
  ? path.resolve(process.env.COMMANDCODE_ENV_PATH)
  : path.join(PROJECT_ROOT, '.env');
const CONFIG_PATH = process.env.COMMANDCODE_CONFIG_PATH
  ? path.resolve(process.env.COMMANDCODE_CONFIG_PATH)
  : path.join(PROJECT_ROOT, 'config.json');

const KEYS = [
  {
    name: 'CREDENTIAL_ENCRYPTION_KEY',
    why: '账号凭据加密存储密钥（AES-256-GCM）。缺失时若有凭据则拒绝启动。',
  },
  {
    name: 'PROXY_API_KEY',
    why: '数据面 /v1/* 的共享密钥；设置后客户端须携带它。未设置则仅本机回环可用。',
  },
  {
    name: 'ADMIN_API_TOKEN',
    why: '管理面写操作凭据。不固定则每次启动随机生成（面板自动携带，脚本调用会受影响）。',
  },
];

const interactive = process.stdin.isTTY === true;

function ask(rl, question, def) {
  if (!interactive) return Promise.resolve(def);
  return new Promise(resolve => {
    rl.question(question, answer => resolve((answer || '').trim() || def));
  });
}

function genKey() {
  return crypto.randomBytes(32).toString('hex');
}

/** 解析现有 .env（KEY=VALUE，忽略注释），返回 Map。 */
function readEnvFile(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

/** 原子写入 .env（整文件重写，保留原有行顺序与未知行）。 */
function writeEnvFile(file, map) {
  const lines = [];
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const line = raw.trim();
      const eq = line.indexOf('=');
      if (line && !line.startsWith('#') && eq > 0) {
        const key = line.slice(0, eq).trim();
        if (map.has(key)) {
          lines.push(`${key}=${map.get(key)}`);
          map.delete(key);
          continue;
        }
      }
      lines.push(raw);
    }
  }
  for (const [k, v] of map) lines.push(`${k}=${v}`);
  const text = lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n') + '\n';
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, file);
}

async function main() {
  console.log('\n=== CommandCode Proxy 启动向导 ===\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // ── 1. 密钥 ──────────────────────────────────────────────────────────────
    const envMap = readEnvFile(ENV_PATH);
    const pending = new Map();
    const generated = [];
    const reused = [];

    for (const key of KEYS) {
      const fromEnvFile = envMap.get(key.name);
      const fromProcess = process.env[key.name];
      if (fromEnvFile || fromProcess) {
        reused.push(key.name);
        console.log(`  ✓ ${key.name} 已存在（沿用，不覆盖）`);
        continue;
      }
      const value = genKey();
      pending.set(key.name, value);
      generated.push(key.name);
      console.log(`  + ${key.name} 已生成`);
      console.log(`      ${key.why}`);
    }

    // ── 2. 落盘位置 ──────────────────────────────────────────────────────────
    let target = 'env';
    if (generated.length > 0) {
      target = await ask(
        rl,
        '\n密钥写入哪里？[env] 项目 .env（已在 .gitignore）/ [print] 只打印，自行配置到系统环境: ',
        'env',
      );
    }

    if (generated.length > 0) {
      if (target === 'print') {
        console.log('\n请把以下内容配置为系统/用户级环境变量：\n');
        for (const [k, v] of pending) console.log(`  ${k}=${v}`);
        console.log('');
      } else {
        writeEnvFile(ENV_PATH, new Map(pending));
        console.log(`\n  ✓ 已写入 ${ENV_PATH}`);
      }
    }

    // ── 3. 最小 config.json ─────────────────────────────────────────────────
    let config = {};
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        console.log(`  ✓ 已存在 ${CONFIG_PATH}（不覆盖）`);
      } catch {
        console.log(`  ⚠ ${CONFIG_PATH} 存在但无法解析为 JSON，跳过最小配置生成（请先修复）。`);
      }
    } else {
      config = { port: 9090, host: '127.0.0.1', acceptedRiskDisclaimer: false };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
      console.log(`  + 已生成最小配置 ${CONFIG_PATH}`);
    }

    // ── 4. 风险告知确认 ─────────────────────────────────────────────────────
    console.log('\n--- 合规风险告知 ---');
    console.log('本网关对接的上游接口均为非公开 / 逆向接口，存在账号封禁、额度清零与合规风险；');
    console.log('本项目仅供个人学习与研究使用，不内置、不分发任何凭据，使用后果由使用者自行承担。');
    console.log('（详见 README「合规风险告知」章节）\n');

    const answer = await ask(rl, '是否确认已阅读并自行承担上述风险？[y/N]: ', 'n');
    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      config.acceptedRiskDisclaimer = true;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
      console.log('  ✓ 已确认，acceptedRiskDisclaimer = true');
    } else {
      console.log('  ! 未确认 —— /v1/* 请求将持续返回 403，直到你在面板上确认或设置 ACCEPTED_RISK_DISCLAIMER=1');
    }

    // ── 5. 下一步 ───────────────────────────────────────────────────────────
    console.log('\n=== 完成 ===');
    if (reused.length) console.log(`沿用已有密钥: ${reused.join(', ')}`);
    console.log('下一步：');
    console.log('  npm run dev      # 开发模式（自动打开面板）');
    console.log('  npm start        # 生产模式（需先 npm run build）');
    console.log('面板打开后，在「账号与鉴权」页添加上游账号即可开始使用。\n');
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(`[setup] 向导失败: ${err?.message || err}`);
  process.exit(1);
});
