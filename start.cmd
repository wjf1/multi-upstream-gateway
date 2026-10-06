@echo off
rem CommandCode Proxy v4 - autostart launcher (Windows Task Scheduler)
rem Resolve this script's own directory so the checkout can live anywhere.
cd /d "%~dp0"
set NO_OPEN_BROWSER=1
rem 上游白名单：即使系统 DNS 被代理软件 fake-ip 化（198.18.x.x），
rem 也跳过该域名的 DNS rebinding 校验，避免 BLOCKED_HOST 秒败。
set COMMANDCODE_UPSTREAM_ALLOWED_HOSTS=api.commandcode.ai
rem 出站代理支持：若配置与系统/用户环境都未指定，默认走本机科学上网客户端
rem 的混合端口（7900；2026-10-06 随 Clash Verge 端口变更从 7897 调整），
rem 避免海外 Cloudflare 节点直连 TCP 超时（UND_ERR_CONNECT_TIMEOUT）。
rem 注意：端口在四处各有一份（本文件、watchdog.ps1、.env、config.json 的
rem upstream.proxy），改一处必须同步四份 —— 只改配置不改启动脚本，会静默
rem 漂移成"探活失败→回退直连"（2026-10-07 实测）。
if not defined HTTPS_PROXY set "HTTPS_PROXY=http://127.0.0.1:7900"
if not defined HTTP_PROXY set "HTTP_PROXY=http://127.0.0.1:7900"
if not defined NO_PROXY set "NO_PROXY=localhost,127.0.0.1,::1"
if not exist "logs" mkdir logs
rem Prefer a standard Node.js install over whatever "node" PATH resolves to
rem (bundled runtimes from other tools can shadow it), then fall back to PATH.
set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE set "NODE=node"
rem Logger persists to logs/proxy.log itself; keep console output separate
rem (two writers on one file would interleave/corrupt lines).
"%NODE%" dist/index.js >> logs\console.log 2>&1
