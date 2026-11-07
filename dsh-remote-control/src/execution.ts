import path from "node:path";
import type { RemoteMachine } from "./registry.js";

export function isRemoteAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value) || value.startsWith("/");
}

export function executionDefaults(machine: RemoteMachine, cwd?: string, env?: Record<string, string>) {
  if (!machine.enabled) throw new Error(`机器 "${machine.id}" 已停用。`);
  const selected = cwd ?? machine.defaultCwd ?? machine.workspace;
  if (!selected) throw new Error(`机器 "${machine.id}" 尚未选择工作区；请先 remote_workspace(operation=set)，或显式提供绝对 cwd。`);
  if (/^[A-Za-z]:[^\\/]/.test(selected) || selected.startsWith("\\") && !selected.startsWith("\\\\")) {
    throw new Error("cwd 不能使用依赖当前盘符的 Windows 路径，请提供绝对路径。");
  }
  let resolved = selected;
  if (!isRemoteAbsolute(selected)) {
    if (!machine.workspace || !isRemoteAbsolute(machine.workspace)) throw new Error("相对 cwd 需要已保存的绝对工作区。");
    resolved = (machine.platform === "win32" ? path.win32 : path.posix).resolve(machine.workspace, selected);
  }
  if (!isRemoteAbsolute(resolved)) throw new Error("远程工作目录必须是绝对路径。");
  return { cwd: resolved, env: { ...machine.defaultEnv, ...env } };
}

export function validateDefaultEnv(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("default_env 必须是字符串值对象；用 {} 清除。");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new Error("默认环境变量名称不合法或值不是字符串。");
    }
    result[key] = value;
  }
  return result;
}
