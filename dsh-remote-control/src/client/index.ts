/**
 * dsh-remote-control — settings panel half ("远程控制" section).
 *
 * ModuleLoader bundle + React function component, mirroring the working
 * memory-plugin client convention. The slots framework isolates per-entry
 * crashes, and this module additionally wraps apply/render paths so a broken
 * panel can never block the web client boot.
 *
 * Host API: /dsh-remote-control/api  (machines/save/connect/probe/remove).
 */
if (typeof window !== "undefined" && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: "@dsh-external/dsh-remote-control",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      var react = require("react");
      var primitives = (function () { try { return require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) { return null; } })();
      var Menu = primitives && primitives.Menu;
      var h = react.createElement;

      // 与权限按钮一致的 16px 图标（本机=显示器，远程=桌面），用 currentColor 继承文字色。
      function targetGlyph(remote) {
        if (remote) {
          return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
            h("rect", { x: 1.6, y: 2.6, width: 12.8, height: 8.6, rx: 1.6, stroke: "currentColor", strokeWidth: 1.3 }),
            h("path", { d: "M5.4 13.4h5.2", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
          );
        }
        return h("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
          h("rect", { x: 1.8, y: 2.2, width: 12.4, height: 8.2, rx: 1.4, stroke: "currentColor", strokeWidth: 1.3 }),
          h("path", { d: "M8 10.4v3.2M5.2 13.6h5.6", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
        );
      }
      function chevron(open) {
        return h("span", { className: "chev" + (open ? " open" : ""), "aria-hidden": true },
          h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none" },
            h("path", { d: "M4 6l4 4 4-4", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" }),
          ),
        );
      }

      var API = "/dsh-remote-control/api";

      function fetchJson(path, init) {
        return fetch(API + path, {
          headers: { "content-type": "application/json" },
          ...init,
        }).then(function (r) { return r.json(); });
      }

      var CSS = [
        ".dshrc-panel{max-width:760px;display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}",
        ".dshrc-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}",
        ".dshrc-form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-2)}",
        ".dshrc-field{display:flex;flex-direction:column;gap:4px;min-width:130px;flex:1}",
        ".dshrc-field.wide{flex:2;min-width:220px}",
        ".dshrc-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
        ".dshrc-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 9px;font:inherit;font-size:13px;width:100%;box-sizing:border-box}",
        ".dshrc-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
        ".dshrc-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}",
        ".dshrc-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}",
        ".dshrc-btn:disabled{opacity:.5;cursor:default}",
        ".dshrc-btn.primary{background:var(--dsw-alias-state-business-primary,#3964fe);border-color:transparent;color:#fff}",
        ".dshrc-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
        ".dshrc-msg{white-space:pre-wrap;max-height:260px;overflow:auto;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);font-size:12px}",
        ".dshrc-msg.err{border-color:var(--dsw-alias-state-error-primary)}",
        ".dshrc-item{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-2)}",
        ".dshrc-item .info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
        ".dshrc-item .title{font-weight:600;display:flex;gap:8px;align-items:center}",
        ".dshrc-item .meta{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dshrc-badge{font-size:10px;padding:2px 7px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}",
        ".dshrc-badge.on{background:rgba(46,204,113,.14);color:#2ecc71;border-color:transparent}",
        ".dshrc-badge.off{background:rgba(255,193,7,.12);color:#f1c40f;border-color:transparent}",
        ".dshrc-badge.busy{background:rgba(255,153,51,.14);color:var(--dsw-alias-label-primary);border-color:transparent}",
        ".dshrc-check{display:flex;align-items:center;gap:6px;padding:6px 0}",
        ".dshrc-actions{display:flex;gap:6px}",
        // ── 聊天框工具行内的目标 chip：数值与「权限按钮」同源 ──
        // 高度/圆角/字号/配色/间距取自 PermissionSelect.module.css；宽度按内容自适应。
        ".dshrc-ctl-root{display:inline-flex;align-items:center;align-self:center;flex:0 0 auto;height:28px;line-height:0;vertical-align:middle}",
        ".dshrc-ctl-trigger{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:180px;height:28px;box-sizing:border-box;padding:0 4px 0 6px;border:none;border-radius:24px;outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;flex:0 0 auto;align-self:center;vertical-align:middle}",
        ".dshrc-ctl-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
        ".dshrc-ctl-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}",
        ".dshrc-ctl-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
        ".dshrc-ctl-trigger .ico{display:inline-flex;flex:0 0 auto}",
        ".dshrc-ctl-trigger .ico svg{width:14px;height:14px}",
        ".dshrc-ctl-trigger .txt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dshrc-ctl-trigger .chev{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-label-caption);transition:transform 120ms ease}",
        ".dshrc-ctl-trigger .chev.open{transform:rotate(180deg)}",
        // 远程模式但尚未选择电脑：用提示色，弱化但仍可点。
        ".dshrc-ctl-trigger.dshrc-ctl-missing{color:var(--dsw-alias-label-tertiary)}",
        // ── 面板样式 ──
        ".dshrc-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:10px}",
        ".dshrc-cardhead{display:flex;align-items:center;justify-content:space-between;gap:8px}",
        ".dshrc-cardtitle{font-weight:600;font-size:13px}",
        ".dshrc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}",
        ".dshrc-empty{text-align:center;padding:22px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-tertiary);font-size:12px}",
        ".dshrc-item.current{border-color:#3964fe;box-shadow:0 0 0 1px #3964fe inset}",
        ".dshrc-btn.sm{padding:4px 10px;font-size:12px}",
        ".dshrc-kv{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ].join("");

      var tagId = "dsh-remote-control/main.css";
      if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
        var tag = document.createElement("style");
        tag.dataset.plugin = "dsh-remote-control";
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }

      function field(label, value, onChange, props) {
        var p = props || {};
        return h("label", { className: "dshrc-field" },
          h("span", { className: "dshrc-label" }, label),
          h("input", Object.assign({}, {
            className: "dshrc-input",
            value: value,
            onChange: function (e) { onChange(e.target.value); },
          }, p)),
        );
      }

      function formatTimestamp(value) {
        if (!value) return "（尚无记录）";
        var date = new Date(value);
        return Number.isNaN(date.getTime()) ? "（时间未知）" : date.toLocaleString();
      }

      // ── 聊天框工具行内的目标选择器 ──
      // 视觉与「模型/权限」按钮一致；显示逻辑参考 Codex：触发器显示当前环境，
      // 点开一个列表，本机与所有电脑平铺、选中打勾。
      function TargetControls() {
        var modelHook = react.useState({ mode: "local", active: null, machines: [] });
        var state = modelHook[0];
        var setState = modelHook[1];
        var openHook = react.useState(false);
        var open = openHook[0];
        var setOpen = openHook[1];
        var hostOpenHook = react.useState(false);
        var hostOpen = hostOpenHook[0];
        var setHostOpen = hostOpenHook[1];

        function load() {
          fetchJson("/state")
            .then(function (data) {
              if (data && data.ok) setState({ mode: data.mode || "local", active: data.active || null, machines: data.machines || [] });
            })
            .catch(function () { /* 控件永不阻断输入 */ });
        }

        react.useEffect(function () {
          load();
          var timer = window.setInterval(load, 30_000);
          function onFocus() { load(); }
          window.addEventListener("focus", onFocus);
          return function () { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
        }, []);

        // 外点关闭由官方 Menu 组件内部处理（它会同时排除 anchor 与 portal 列表），
        // 这里不再自建 mousedown 监听，否则会在 click 之前把菜单卸载掉导致点击无效。

        function post(payload) {
          return fetchJson("/activate", { method: "POST", body: JSON.stringify(payload) })
            .then(function (data) {
              if (data && data.ok) {
                setState(function (prev) { return { mode: data.mode || prev.mode, active: data.active || null, machines: prev.machines }; });
              }
            })
            .catch(function () { /* 失败保持原状态 */ });
        }
        function chooseMode(mode) { setOpen(false); setHostOpen(false); return post({ mode: mode }); }
        function chooseMachine(id) {
          setOpen(false); setHostOpen(false);
          if (id === "__settings__") return; // 引导项：不切换，仅作提示
          return post({ mode: "remote", machine: id || "" });
        }

        var isRemote = state.mode === "remote";
        var active = state.active;
        var machines = state.machines || [];

        // ① 模式按钮（时刻显示）：本机 / 远程。
        var modeLabel = isRemote ? "远程" : "本机";
        var modeItems = [
          { id: "local", label: "本机" },
          { id: "remote", label: "远程电脑" },
        ];
        var modeTrigger = h("button", {
          type: "button",
          className: "dshrc-ctl-trigger",
          title: "执行位置：本机 / 远程电脑（仅为工具默认目标，不改变命令权限）",
          "aria-haspopup": "menu",
          "aria-expanded": open,
          onClick: function () { setHostOpen(false); setOpen(function (v) { return !v; }); },
        },
          h("span", { className: "ico", "aria-hidden": true }, targetGlyph(isRemote)),
          h("span", { className: "txt" }, modeLabel),
          chevron(open),
        );
        var modeControl = Menu
          ? h(Menu, {
              open: open, anchor: modeTrigger, items: modeItems,
              selectedId: isRemote ? "remote" : "local",
              side: "top", align: "start", portal: true, dense: true, className: "dshrc-ctl-root",
              onSelect: function (id) { chooseMode(id); },
              onClose: function () { setOpen(false); },
            })
          : modeTrigger;

        // ② 电脑按钮：仅远程模式出现；无登记电脑时显示“未选择”，但仍可点开看到引导。
        var hostControl = null;
        if (isRemote) {
          var hasMachines = machines.length > 0;
          var hostLabel = active ? (active.name || active.id) : (hasMachines ? "选择电脑" : "未选择电脑");
          var hostItems = hasMachines
            ? machines.map(function (m) {
                return { id: m.id, label: m.name + (m.name !== m.id ? " (" + m.id + ")" : ""), disabled: m.enabled === false };
              })
            : [
                { type: "label", id: "__hint__", text: "还没有登记远程电脑" },
                { id: "__settings__", label: "前往 设置 → 远程控制 添加" },
              ];
          var hostTrigger = h("button", {
            type: "button",
            className: "dshrc-ctl-trigger" + (active ? "" : " dshrc-ctl-missing"),
            title: hasMachines ? (active ? "点击切换目标电脑" : "选择远程电脑") : "还没有登记远程电脑，点此查看如何添加",
            "aria-haspopup": "menu",
            "aria-expanded": hostOpen,
            onClick: function () { setOpen(false); setHostOpen(function (v) { return !v; }); },
          },
            h("span", { className: "txt" }, hostLabel),
            chevron(hostOpen),
          );
          hostControl = Menu
            ? h(Menu, {
                open: hostOpen, anchor: hostTrigger, items: hostItems,
                selectedId: active ? active.id : undefined,
                side: "top", align: "start", portal: true, dense: true, className: "dshrc-ctl-root",
                onSelect: function (id) { chooseMachine(id); },
                onClose: function () { setHostOpen(false); },
              })
            : hostTrigger;
        }

        return h(react.Fragment, null, modeControl, hostControl);
      }

      function RemoteControlSection() {
        var [form, setForm] = react.useState({ name: "", host: "", username: "", password: "", os: "auto", port: "5188", localWorkspace: "", tunnelUrl: "", autoConnect: false });
        var [busy, setBusy] = react.useState("");
        var [msg, setMsg] = react.useState(null);
        var [machines, setMachines] = react.useState([]);
        var [statuses, setStatuses] = react.useState({});
        var [activeId, setActiveId] = react.useState(null);

        function setActive(machineId) {
          fetchJson("/activate", { method: "POST", body: JSON.stringify({ machine: machineId || "" }) })
            .then(function (r) { if (r && r.ok) setActiveId(machineId || null); })
            .catch(function () { setMsg({ text: "切换目标失败", err: true }); });
        }

        function setField(key) {
          return function (value) {
            setForm(function (prev) {
              var next = Object.assign({}, prev);
              next[key] = value;
              return next;
            });
          };
        }

        function refresh() {
          fetchJson("/machines")
            .then(function (data) {
              if (!data || !data.ok) {
                setMsg({ text: "加载失败：" + ((data && data.error) || "未知错误"), err: true });
                return;
              }
              setMachines(data.machines || []);
              fetchJson("/state").then(function (s) {
                if (s && s.ok) setActiveId(s.active ? s.active.id : null);
              }).catch(function () {});
              Promise.all((data.machines || []).map(function (m) {
                return fetchJson("/probe", { method: "POST", body: JSON.stringify({ id: m.id }) })
                  .then(function (r) { return [m.id, r && r.ok ? r : { online: false, text: "探测失败" }]; })
                  .catch(function () { return [m.id, { online: false, text: "探测失败" }]; });
              })).then(function (pairs) {
                var map = {};
                pairs.forEach(function (pair) { map[pair[0]] = pair[1]; });
                setStatuses(map);
              });
            })
            .catch(function (e) { setMsg({ text: "加载失败：" + String(e), err: true }); });
        }

        react.useEffect(function () {
          refresh();
          var timer = window.setInterval(refresh, 60_000);
          return function () { window.clearInterval(timer); };
        }, []);

        function doSave() {
          if (!form.host || !form.username) {
            setMsg({ text: "IP 地址、用户名均为必填（无密码的电脑密码留空即可）", err: true });
            return;
          }
          setBusy("save");
          fetchJson("/save", { method: "POST", body: JSON.stringify(form) })
            .then(function (r) {
              setMsg(r && r.ok
                ? { text: "已保存组合 " + r.machine.id + "（本机工作区：" + r.machine.localWorkspace + "）", err: false }
                : { text: "保存失败：" + ((r && r.error) || "未知错误"), err: true });
              if (r && r.ok) setTimeout(refresh, 400);
            })
            .catch(function (e) { setMsg({ text: "请求失败：" + String(e), err: true }); })
            .finally(function () { setBusy(""); });
        }

        function doConnect() {
          if (!form.host || !form.username) {
            setMsg({ text: "IP 地址、用户名均为必填（无密码的电脑密码留空即可）", err: true });
            return;
          }
          setBusy("connect");
          setMsg({ text: "一步连接中（自动部署/上线/建工作区/验证，约 1~2 分钟；Windows 全自动）…", err: false });
          fetchJson("/connect", { method: "POST", body: JSON.stringify(form) })
            .then(function (r) {
              setMsg(r && r.ok
                ? { text: String(r.result), err: false }
                : { text: "连接失败：" + ((r && r.error) || "未知错误"), err: true });
            })
            .catch(function (e) { setMsg({ text: "请求失败：" + String(e), err: true }); })
            .finally(function () { setBusy(""); setTimeout(refresh, 1500); });
        }

        function doConnectOne(m) {
          setBusy("connect-" + m.id);
          setMsg({ text: "连接 " + m.id + " 中…", err: false });
          fetchJson("/connect", { method: "POST", body: JSON.stringify({ id: m.id, os: m.osHint || "auto" }) })
            .then(function (r) {
              setMsg(r && r.ok
                ? { text: String(r.result), err: false }
                : { text: "连接失败：" + ((r && r.error) || "未知错误"), err: true });
            })
            .catch(function (e) { setMsg({ text: "请求失败：" + String(e), err: true }); })
            .finally(function () { setBusy(""); setTimeout(refresh, 1500); });
        }

        function doRemove(m) {
          if (!window.confirm("移除组合 \"" + m.id + "\"？")) return;
          setBusy("remove-" + m.id);
          fetchJson("/remove", { method: "POST", body: JSON.stringify({ id: m.id }) })
            .then(function (r) {
              setMsg(r && r.ok ? { text: "已移除", err: false } : { text: "移除失败：" + ((r && r.error) || "未知错误"), err: true });
              if (r && r.ok) setTimeout(refresh, 400);
            })
            .catch(function (e) { setMsg({ text: "请求失败：" + String(e), err: true }); })
            .finally(function () { setBusy(""); });
        }

        var items = machines.map(function (m) {
          var status = statuses[m.id];
          var busyJobs = status && status.online ? Number(status.busyJobs) || 0 : 0;
          var lastSeen = status && status.online && status.checkedAt ? status.checkedAt : m.lastSeenAt;
          var envKeys = Array.isArray(m.defaultEnvKeys) ? m.defaultEnvKeys.filter(function (key) { return typeof key === "string"; }) : [];
          var osText = m.platform === "win32" ? "Win" : m.platform === "linux" ? "Linux"
            : m.osHint === "windows" ? "Win?" : m.osHint === "linux" ? "Linux?" : "auto";
          var isActive = activeId === m.id;
          return h("div", { className: "dshrc-item" + (isActive ? " current" : ""), key: m.id },
            h("div", { className: "info" },
              h("div", { className: "title" },
                h("span", null, m.name + (m.name !== m.id ? " (" + m.id + ")" : "")),
                h("span", { className: "dshrc-badge" }, osText),
                m.tunnelUrl ? h("span", { className: "dshrc-badge" }, "隧道") : null,
                status
                  ? h("span", { className: "dshrc-badge " + (status.online ? "on" : "off") }, status.online ? "在线" : "离线")
                  : null,
                busyJobs > 0 ? h("span", { className: "dshrc-badge busy" }, "繁忙 · " + busyJobs + " 个任务") : null,
                m.autoConnect ? h("span", { className: "dshrc-badge" }, "自动连接") : null,
                isActive ? h("span", { className: "dshrc-badge on" }, "当前目标") : null,
              ),
              h("div", { className: "meta" }, (m.tunnelUrl ? "隧道：" + m.tunnelUrl + "  " : "") + m.host + ":" + m.port + "  远程工作区：" + (m.workspace || "（上线自动同步）")),
              h("div", { className: "meta" }, "本机工作区：" + (m.localWorkspace || "（未设置）") + (m.hasPassword ? "  ·  密码已保存" : "  ·  密码留空")),
              h("div", { className: "meta" }, "主机名：" + (m.lastHostname || "（未探测）") + "  ·  agent：" + (m.lastAgentVersion || "（未知）") + "  ·  最后在线：" + formatTimestamp(lastSeen)),
              h("div", { className: "meta", title: m.defaultCwd || "" }, "默认执行目录：" + (m.defaultCwd || "（使用远程工作区）")),
              envKeys.length > 0 ? h("div", { className: "meta", title: envKeys.join(", ") }, "默认环境变量名：" + envKeys.join(", ")) : null,
              status && status.text ? h("div", { className: "meta", title: status.text }, status.text + (status.checkedAt ? "  ·  检查于 " + formatTimestamp(status.checkedAt) : "")) : null,
            ),
            h("div", { className: "dshrc-actions" },
              isActive
                ? h("button", { className: "dshrc-btn", onClick: function () { setActive(null); } }, "切回本机")
                : h("button", { className: "dshrc-btn", onClick: function () { setActive(m.id); } }, "设为当前"),
              h("button", { className: "dshrc-btn primary", disabled: busy === "connect-" + m.id, onClick: function () { doConnectOne(m); } }, "连接"),
              h("button", { className: "dshrc-btn danger", disabled: busy === "remove-" + m.id, onClick: function () { doRemove(m); } }, "移除"),
            ),
          );
        });

        return h("div", { className: "dshrc-panel" },
          h("div", { className: "dshrc-cardhead" },
            h("h3", { style: { margin: 0 } }, "远程控制"),
            h("button", { className: "dshrc-btn sm", disabled: busy !== "", onClick: refresh }, "刷新状态"),
          ),
          h("p", { className: "dshrc-hint" }, "在输入框上方点当前目标即可切换「本机 / 远程电脑」。这里保存连接组合；对话中 remote_connect 接入的机器会同步出现。密码保存在本机登记表，列表不显示。"),

          h("div", { className: "dshrc-card" },
            h("div", { className: "dshrc-cardhead" },
              h("span", { className: "dshrc-cardtitle" }, "添加 / 连接一台电脑"),
              h("span", { className: "dshrc-kv" }, "无密码的电脑密码留空"),
            ),
            h("div", { className: "dshrc-grid" },
              field("名称", form.name, setField("name"), { placeholder: "如：办公室主机（可选）" }),
              field("IP 地址 *", form.host, setField("host"), { placeholder: "192.168.1.20" }),
              field("用户名 *", form.username, setField("username"), { placeholder: "Administrator" }),
              h("label", { className: "dshrc-field" },
                h("span", { className: "dshrc-label" }, "密码（无密码可留空）"),
                h("input", { className: "dshrc-input", type: "password", value: form.password, placeholder: "无密码留空", onChange: function (e) { setField("password")(e.target.value); } }),
              ),
              h("label", { className: "dshrc-field" },
                h("span", { className: "dshrc-label" }, "操作系统"),
                h("select", { className: "dshrc-input", value: form.os, onChange: function (e) { setField("os")(e.target.value); } },
                  h("option", { value: "auto" }, "自动检测"),
                  h("option", { value: "windows" }, "Windows"),
                  h("option", { value: "linux" }, "Linux"),
                ),
              ),
              h("label", { className: "dshrc-field" },
                h("span", { className: "dshrc-label" }, "端口"),
                h("input", { className: "dshrc-input", type: "number", value: form.port, onChange: function (e) { setField("port")(e.target.value); } }),
              ),
            ),
            h("div", { className: "dshrc-grid" },
              field("公网隧道地址（可选）", form.tunnelUrl, setField("tunnelUrl"), { className: "dshrc-field wide", placeholder: "https://xxx.trycloudflare.com（留空 = 直连/反向）" }),
              field("本机工作区目录", form.localWorkspace, setField("localWorkspace"), { className: "dshrc-field wide", placeholder: "留空 = 登记表同目录 workspaces/<id>" }),
            ),
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" } },
              h("label", { className: "dshrc-check" },
                h("input", { type: "checkbox", checked: form.autoConnect, onChange: function (e) { setField("autoConnect")(e.target.checked); } }),
                "启动时自动探测状态",
              ),
              h("div", { className: "dshrc-actions" },
                h("button", { className: "dshrc-btn", disabled: busy !== "", onClick: doSave }, "保存组合"),
                h("button", { className: "dshrc-btn primary", disabled: busy !== "", onClick: doConnect }, "一步连接"),
              ),
            ),
          ),

          msg
            ? h("div", { className: "dshrc-msg" + (msg.err ? " err" : "") }, msg.text)
            : null,

          h("div", { className: "dshrc-cardhead" },
            h("span", { className: "dshrc-cardtitle" }, "已保存的电脑"),
            h("span", { className: "dshrc-kv" }, machines.length + " 台 · 在线状态每 60 秒自动刷新"),
          ),
          items.length > 0
            ? items
            : h("div", { className: "dshrc-empty" }, "还没有保存的目标机。填写上方表单保存，或在对话里用 remote_connect 接入。"),
        );
      }

      function apply(ctx) {
        try {
          ctx.effect(function () {
            return ctx.slots.inject("settings.section", function () {
              return ctx.slots.register({
                name: "settings.section",
                id: "dsh-remote-control",
                order: 28,
                label: function () { return "远程控制"; },
                locale: "dshRemoteControl",
              }, function () { return h(RemoteControlSection); });
            });
          }, "dsh-remote-control: settings section");
        } catch (error) {
          try {
            console.error("[dsh-remote-control] 设置面板注册失败（已降级，不影响客户端启动）:", error);
          } catch {
            // 控制台都不可用时彻底静默。
          }
        }
        // 聊天框工具行内的紧凑控件（Codex 风格）。独立 try：
        // 插槽缺失或渲染异常都不影响输入框与其它插件。
        try {
          ctx.effect(function () {
            return ctx.slots.inject("conversation.input.left", function () {
              return ctx.slots.register({
                name: "conversation.input.left",
                id: "dsh-remote-control-target",
                order: 0,
                locale: "dshRemoteControl",
              }, function () { return h(TargetControls); });
            });
          }, "dsh-remote-control: target controls");
        } catch (error) {
          try {
            console.error("[dsh-remote-control] 目标指示器注册失败（已降级，不影响输入框）:", error);
          } catch {
            // 控制台都不可用时彻底静默。
          }
        }
      }

      exports.apply = apply;
      exports.inject = ["slots"];
      return module.exports;
    },
  });
}
