# dsh-remote-control

让 DeepSeek Harness 通过一组 `remote_*` 工具连接**你自己的其它电脑**：在指定机器、指定目录执行命令、读写文件、跑后台任务。

- **控制器**：运行在 DSH 内的本插件，保存机器登记表，提供工具与「设置 → 远程控制」面板，并在输入框上方显示当前目标。
- **目标机**：运行零依赖单文件 agent（Node.js 18+），支持直连、认证反向隧道和公网 HTTP 隧道。
- **当前版本**：插件 `0.7.0`，agent `1.5.0`。旧 agent 仍可用；忙碌状态、保持唤醒等新能力需要 1.5.0。

> 本插件只做「远程控制你自己的电脑」，不提供云端算力，也不接管 DSH 新对话的执行主机选择。

## 快速开始

```bash
# 1. 目标机启动 agent（随机密钥，换成你自己的）
node agent/dsh-remote-agent.mjs --port 5188 --token <随机密钥> --workspace /srv/projects

# 2. 控制器登记
remote_machine_add(id=build-pc, host=192.168.1.30, token=<同一随机密钥>)

# 3. 选工作区（必须是已存在目录），然后执行
remote_workspace(machine=build-pc, operation=set, path=/srv/projects)
remote_exec(machine=build-pc, command="git status")
```

或让插件全自动接入（Windows + SMB）：`remote_connect(host=…, username=…, password=…)`。

## 能做什么

| 能力 | 工具 |
|---|---|
| 接入 / 部署 | `remote_connect`、`remote_connect_reverse`、`remote_deploy_command`、`remote_tunnel` |
| 诊断 | `remote_diagnose` |
| 机器管理 | `remote_machine_list`、`remote_machine_add`、`remote_machine_configure`、`remote_machine_remove` |
| 工作区 | `remote_workspace` |
| 执行 | `remote_exec`、`remote_exec_bg`、`remote_job` |
| 文件 | `remote_fs`、`remote_upload`、`remote_download` |
| 信息 | `remote_sysinfo`、`remote_processes` |

完整用法见下文各节。输入框上方的目标条可一键切换「本机 / 远程电脑」。

## 接入电脑

### Windows 一步接入

目标机开启 SMB 管理共享，账号具有相应权限时，可以自动部署并创建默认工作区：

```text
remote_connect(host=192.168.1.20, username=Administrator, password=<目标机密码>)
```

插件会推送 agent、创建并启动计划任务、尝试放行 agent 端口并验证连接。自动部署失败时返回原因与手动部署方案。
空密码账户通常不能进行 Windows 网络登录，可在目标机控制台执行返回的部署命令。

### Linux 手动执行部署命令

```text
remote_connect(id=build-pc, host=192.168.1.30, username=developer, os=linux)
```

返回 gzip + base64 折行部署命令，在目标机完整粘贴执行；需要目标机已有 Node.js。
agent 上报默认工作区后，机器列表探测会同步它。此路径不会因提供用户名或密码就自动通过 SSH 部署。

### 已有 agent：登记、选择目录、配置运行环境

以下凭据均为占位符，应替换为自己的随机密钥；不要照抄为实际密码。

```bash
# 目标机
node agent/dsh-remote-agent.mjs --host 127.0.0.1 --port 5188 --token <随机密钥> --workspace /srv/projects
```

直连其他电脑时监听地址需改为目标机可达的地址，并配置网络访问；仅经目标机本地 HTTP 隧道访问时可保持回环监听。

```text
remote_machine_add(id=build-pc, host=192.168.1.30, token=<同一随机密钥>)
remote_workspace(machine=build-pc, operation=set, path=/srv/projects)
remote_machine_configure(machine=build-pc, name=构建电脑, auto_connect=true, default_cwd=/srv/projects/app, default_env={"CI":"1"})
remote_exec(machine=build-pc, command="npm run build", env={"CI":"0"})
```

`default_cwd` 必须在线验证为现有目录；最后一次调用中 `CI=0` 覆盖机器默认的 `CI=1`。

## 不在同一局域网

### 反向接入

目标机能连回控制器时：

```text
remote_connect_reverse(id=build-pc, host=192.168.1.30, controller_host=<目标机可达的控制器地址>)
```

执行返回的部署命令后，agent 主动回连认证网关（默认 59000），断开后重连并通过心跳探测连接。
控制器的网关需对目标机可达；本地代理端口无需向公网开放。
复取部署命令使用 `remote_deploy_command(machine=build-pc)`。

### 公网 HTTP 隧道

目标机运行 agent，再用 Cloudflare Tunnel、ngrok 或其他 HTTP 隧道转发 agent 端口。例如：

```bash
cloudflared tunnel --url http://127.0.0.1:5188
```

将输出的 HTTPS 地址挂到已登记机器上：

```text
remote_tunnel(machine=build-pc, action=set, url=https://example.trycloudflare.com)
remote_tunnel(machine=build-pc, action=show)
remote_diagnose(host=https://example.trycloudflare.com)
remote_tunnel(machine=build-pc, action=clear)
```

也可以在 `remote_machine_add` 中传 `tunnel_url`。普通远程操作仍使用同一个机器 id。
临时地址变化后重新 `set` 即可；本插件不托管 cloudflared，也不自动更新服务商分配的地址。
dsh-bridge 通常转发 DSH 网页入口，此处需要转发目标机的 agent 端口。

- 公网隧道要求 HTTPS；回环 HTTP 地址仅用于本机测试。
- 只有能够确认请求尚未送达的连接错误才尝试其他路径。超时、认证失败或可能已执行的写操作不会自动重放，避免重复执行命令。
- 请求拒绝重定向，防止凭据被带到其它站点；请求期限涵盖响应正文读取。
- 隧道模式使用 **90 秒同步执行超时、95 MiB 单文件上传阈值**作为插件保守默认值，服务商和套餐的实际限制可能不同，并非统一的 Cloudflare 硬限制。长命令用后台任务，大文件可分卷或改走其他连接方式。

## 机器目录与默认运行配置

```text
remote_machine_list()
remote_machine_list(refresh=true)
remote_machine_list(probe=false)
remote_machine_configure(machine=build-pc, name=新名称, enabled=true, auto_connect=false)
remote_machine_configure(machine=build-pc, default_cwd=/srv/projects/app, default_env={"CI":"1"})
remote_machine_configure(machine=build-pc, default_env={})
remote_machine_remove(id=build-pc)
```

- 状态缓存有效期 **15 秒**；`refresh=true` 强制刷新，`probe=false` 不联网。未探测显示未知，不把未知当成离线。
- 目录显示在线/离线/繁忙、上次主机名、agent 版本和最后在线时间。旧 agent 不上报任务数时不能据此断言它没有任务。
- `auto_connect` 默认关闭；开启仅表示插件启动时后台探活，不会自动部署或执行命令。
- `remote_machine_configure(machine, name?, enabled?, auto_connect?, default_cwd?, default_env?)` 更新已有机器。默认环境变量需为字符串对象，调用时的 `env` 覆盖同名默认值；不要把密码、token 放进默认变量。
- 同步和后台命令按 **显式 cwd → 机器 defaultCwd → 远程 workspace** 选择执行目录；都未设置时提示错误，不静默落到 agent 启动目录。
- `remote_workspace(operation=set)` 验证目标为目录，并清除旧 `defaultCwd`，让后续命令使用新工作区。
- 在线/繁忙机器默认不能移除；确实需要时可显式 `remote_machine_remove(id=build-pc, force=true)`。移除只删除登记，不卸载 agent、不结束目标机任务。面板被拒绝时显示错误，不自动强制移除。

## 日常操作与后台任务

```text
remote_workspace(machine=build-pc, operation=list)
remote_fs(machine=build-pc, operation=read, path=notes.txt)
remote_upload(machine=build-pc, local_path=<本机文件>, remote_path=package.zip)
remote_download(machine=build-pc, remote_path=report.txt, local_path=<本机保存路径>)
remote_sysinfo(machine=build-pc)
remote_processes(machine=build-pc, action=list)
remote_exec_bg(machine=build-pc, command="npm run build", timeout_ms=1800000)
remote_job(machine=build-pc, action=output, job_id=<返回的任务id>)
remote_job(machine=build-pc, action=list)
remote_job(machine=build-pc, action=kill, job_id=<返回的任务id>)
```

后台任务立即返回 id，可查询状态/输出或结束整个进程树；不传 `timeout_ms` 时不限时。
输出受 agent 缓冲上限限制，任务记录有容量与保留期限；agent 重启后不要期望恢复先前任务。
选择的工作区与执行目录都是路径约定，**不是 shell 沙箱**。

## agent 参数

| 参数 | 用途 | 默认 |
|---|---|---|
| `--port` / `--host` | agent 监听端口和地址 | 5188 / 0.0.0.0 |
| `--token` | 共享密钥 | 未配置时生成 |
| `--token-sha256` | 64 位十六进制凭据模式，与 token 二选一 | 关闭 |
| `--workspace` | 创建并上报默认工作区 | 未设置 |
| `--root` | 约束文件 API 的可访问根目录 | 不限制 |
| `--cert` / `--key` | agent HTTPS 证书和私钥 | 不启用 |
| `--reverse` / `--reverse-pool` | 回连网关地址和连接池 | 不回连 / 4 |
| `--keep-awake` | 可选阻止休眠的运行期请求 | 关闭 |
| `--max-output` / `--max-upload` | 输出和上传字节上限 | 1 MiB / 1 GiB |

agent 1.5.0 的 `/health` 上报忙碌任务数及保持唤醒状态。
`--keep-awake` 使用平台提供的运行期机制，不修改操作系统电源设置；平台支持和权限可能影响实际效果，依据 agent 日志和状态确认。

## 聊天框里的目标选择

聊天框底部工具行左侧有一个选择器，和「权限 / 模型」按钮同排同款（28px 高、圆角胶囊、次要文字色）：

- 触发器显示当前环境名：`本机` 或 `电脑名`；名字过长自动省略。
- 点开是一个列表：**本机 + 所有已登记电脑**平铺，选中项打勾，每项显示工作区、是否停用。
- 选「本机」= 用当前这台电脑；选某台电脑后，远程工具省略 `machine` 默认作用在它上面。
- 设置页电脑卡片同样有「设为当前 / 切回本机」。

> 这只是**工具默认目标**的快捷方式，不是会话隔离，也不改变命令权限；显式 `machine=...` 始终优先。

## 设置页与安装

设置页「远程控制」为卡片式布局：上方是「添加 / 连接一台电脑」表单（名称、IP、用户名、密码、系统、端口、隧道地址、本机工作区、自动探测），下方是「已保存的电脑」列表，卡片显示在线/繁忙/OS/隧道徽标、主机名、agent 版本、最后在线、默认执行目录与默认环境变量**名称**。面板和工具共用同一份登记表。
配置接口仅允许本机回环连接，拒绝公网 Host、转发来源和跨站变更；经公网 DSH 入口访问时请通过对话工具操作，连接配置在本机 GUI 完成。

构建 host 与前端产物后用 `npm pack` 分发，确保运行依赖可解析，并在当前 profile 的 `dsh.profile.bundles` 加入 `@dsh-external/dsh-remote-control`。重启 DSH 后生效；前端 bundle 更新后刷新现有页面。
登记表位于 `DSH_HOME/dsh-remote-control/machines.json`，未配置 `DSH_HOME` 时使用用户目录下的 `.dsh-remote-control`。

## 凭据与权限边界

- `--token-sha256` 模式接受其十六进制值本身作为请求凭据，**该值仍是 bearer secret**，拿到它就能认证。不能把它当作可公开的安全哈希。
- 登记表和部署命令可能含 token、登录密码或运行配置。面板列表不返回密码/token；仍需保护本机文件、部署脚本与会话记录。
- POSIX `0600` 不等于 Windows 私有文件权限；Windows 上需要单独确认实际文件权限。不要因为写入使用了 `0600` 就认为其它用户无法读取。
- agent 以启动用户权限执行 shell 命令。工作区、`default_cwd` 和 `--root` 都不能隔离 shell；`--root` 仅约束文件 API，不限制命令能访问哪些文件或程序。
- 文件 API 对符号链接路径、上传写入及资源使用增加了检查，但这些检查不构成对整台机器的隔离保证。
- 直连 HTTP 应用于可信网络/VPN；公网入口使用 TLS，避免凭据明文经过公网。隧道地址本身不替代认证。

## 故障定位

- 连不上：用 `remote_diagnose` 检查直连地址或隧道 URL，并确认 agent 在目标机实际监听。
- 401：核对 agent 和登记表凭据。隧道网站返回的 200/401 不一定来自 agent，需看认证后的健康检查结果。
- 隧道返回 502/503：检查隧道连接器、源站监听与服务商状态；不要把单一状态码当作唯一原因。
- 执行缺少目录：先 `remote_workspace(operation=set)` 或在线设置 `default_cwd`。
- 删除被拒绝：确认机器状态，必要时显式选择强制移除；正常界面不会自动做这个决定。
- 更新 agent：重新部署包内 agent。若插件加载异常，可从当前 profile 的 bundles 中移除插件名后重启。

## 项目结构

```
dsh-remote-control/
├── src/
│   ├── index.ts        # 插件主体：工具注册、部署流程、设置页 API
│   ├── agent-http.ts   # 控制器侧 HTTP 客户端（超时/重定向/回退策略）
│   ├── registry.ts     # 机器登记表读写（含 activeMachineId）
│   ├── catalog.ts      # 状态探测与 15 秒缓存
│   ├── execution.ts    # cwd/env 解析与默认值合并
│   ├── reverse.ts      # 反向隧道网关
│   └── client/index.ts # 前端：设置页面板 + 输入框上方目标条
├── agent/
│   └── dsh-remote-agent.mjs   # 目标机零依赖 agent（单文件）
├── scripts/            # 构建与自动化测试
├── lib/                # 编译产物（不提交）
├── cordis.patch.yml    # DSH bundle 清单
└── package.json
```

`lib/`、`node_modules/`、`*.tgz` 均为生成物，已在 `.gitignore` 中忽略，克隆后需自行构建。

## 开发与构建

```bash
# 依赖：本机需有 DSH 源码 checkout（脚本会自动探测，或用 DSH_CHECKOUT 指定）
npm run build        # host：src → lib（tsc）
npm run build:client # 前端：src/client → lib/client.js（tsdown）
npm run typecheck    # 类型检查
```

自动化测试（不连接任何真实远程电脑，仅本机回环）：

```bash
node scripts/smoke.mjs                # agent HTTP 接口
node scripts/plugin-smoke.mjs         # 插件工具/面板集成
node scripts/reverse-smoke.mjs        # 反向隧道
node scripts/transport-safety-smoke.mjs   # 超时/重定向/不重放等传输安全
node scripts/workspace-safety-smoke.mjs   # 工作区、目标切换、凭据不回显
node scripts/agent-lifecycle-smoke.mjs    # agent 作业上限、文件 API 边界
```

安装到 DSH：把本包放进插件目录并在 profile 的 `dsh.profile.bundles` 加入
`@dsh-external/dsh-remote-control`，重启 DSH 生效；前端改动后刷新页面。

## 安全须知（提交前请读）

- **不要提交任何真实凭据**：token、登录密码、内网 IP、会话记录。仓库 `.gitignore` 已排除
  `machines.json`、`agent-token.txt`、`*.log`、`*.tgz` 与构建产物。
- 排查时若生成过带 token 的临时脚本/文本，请**先删除或脱敏**再提交。
- 登记表按用户保存在本地（`DSH_HOME/dsh-remote-control/machines.json`，无 `DSH_HOME` 时在
  `~/.dsh-remote-control/`），它包含凭据，切勿入库。
- 发现安全问题请勿公开提 issue，先私下联系维护者。

## License

BSD-3-Clause，见 [LICENSE](LICENSE)。
