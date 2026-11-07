# dsh-remote-control

一个 DeepSeek Harness（DSH）插件：让本机的 DSH 通过一组 `remote_*` 工具**安全地操作你自己的其它电脑**——在指定机器、指定目录执行命令、读写文件、跑后台任务。

- **适合**：把家里的机器、公司的台式机、云服务器接进来，让 AI 直接在上面干活。
- **不适合**：当作公网 shell 服务或多人共享的远程终端；也不提供云端算力。

插件代码在 [`dsh-remote-control/`](dsh-remote-control/)，完整文档见 [插件 README](dsh-remote-control/README.md)。

## 组成

| 角色 | 位置 | 说明 |
|---|---|---|
| 控制器 | 运行 DSH 的本机 | 本插件提供 `remote_*` 工具、设置页面板和输入框上方的「本机 / 远程电脑」目标条 |
| 目标机 | 被控电脑 | 运行零依赖单文件 agent（Node.js 18+），凭 token 认证 |

连接方式三选一：**直连**（同局域网/可达）、**反向隧道**（目标机能连回本机）、**公网 HTTP 隧道**（如 Cloudflare Tunnel）。

## 快速开始

```bash
# 目标机：启动 agent（密钥换成你自己的随机串）
node dsh-remote-control/agent/dsh-remote-agent.mjs --port 5188 \
  --token <随机密钥> --workspace /srv/projects
```

```text
# 控制器（DSH 对话里）
remote_machine_add(id=build-pc, host=192.168.1.30, token=<同一随机密钥>)
remote_workspace(machine=build-pc, operation=set, path=/srv/projects)
remote_exec(machine=build-pc, command="git status")
```

Windows 且账号有 SMB 权限时，可让插件全自动部署：
`remote_connect(host=192.168.1.20, username=Administrator, password=<密码>)`。

## 主要能力

- 机器管理：登记、配置（名称/启停/默认 cwd 与 env）、安全移除、状态与版本探测
- 执行：同步命令、后台长任务（立即返回 job id，可查输出/结束整个进程树）
- 文件：读写/列目录/上传/下载
- 网络：连通性三阶段诊断、认证反向隧道、公网隧道地址管理
- UI：设置页「远程控制」面板 + 输入框上方目标指示器（本机 / 远程电脑一键切换）

## 安装到 DSH

1. 把 `dsh-remote-control/` 放入 DSH 插件目录；
2. 在 profile 的 `dsh.profile.bundles` 加入 `@dsh-external/dsh-remote-control`；
3. 重启 DSH（前端有更新时刷新页面）。

`lib/` 是编译产物、不入库，需自行构建（见插件 README 的「开发与构建」）。

## 安全提醒

- **token 是唯一凭据**，拿到即可控制目标机；`--token-sha256` 模式的那个值本身同样是密钥。
- agent 以启动用户的完整权限执行命令；工作区、默认目录、`--root` 都**不是** shell 沙箱。
- 默认 HTTP 明文仅适合可信内网/VPN；跨公网请用 TLS 隧道或 agent 的 `--cert/--key`。
- 登记表含 token 与登录密码，只保存在本机用户目录，**切勿提交**。
- 本仓库不包含任何真实凭据；如发现安全问题，请私下联系维护者，不要公开提 issue。

## 许可

BSD-3-Clause，见 [LICENSE](dsh-remote-control/LICENSE)。
