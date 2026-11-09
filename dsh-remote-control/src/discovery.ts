/**
 * Discover candidate remote computers from the local machine's own SSH setup,
 * the way a code editor lists previously-used hosts: read ~/.ssh/config entries
 * (Host/HostName/User/Port) and ~/.ssh/known_hosts addresses, plus the keys we
 * already have, so the user does not have to retype IP + user for machines
 * they have connected to before.
 *
 * Read-only: this never connects or modifies anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscoveredHost {
  /** Best identifier: the SSH config alias, else the host address. */
  id: string;
  host: string;
  user?: string;
  port?: number;
  /** Where this candidate came from. */
  source: "ssh-config" | "known-hosts";
  /** Alias from ssh config, when present. */
  alias?: string;
  /** Whether a private key likely exists to authenticate (informational). */
  hint?: string;
}

function sshDir(): string {
  const home = process.env.USERPROFILE || homedir();
  return join(home, ".ssh");
}

function readText(path: string): string {
  try { return existsSync(path) ? readFileSync(path, "utf8") : ""; } catch { return ""; }
}

/** Parse ~/.ssh/config into host entries. Handles Host aliases, HostName, User, Port. */
export function parseSshConfig(text: string): DiscoveredHost[] {
  const out: DiscoveredHost[] = [];
  const lines = text.split(/\r?\n/);
  let current: { aliases: string[]; host?: string; user?: string; port?: number } | null = null;
  const flush = () => {
    if (!current) return;
    for (const alias of current.aliases) {
      // Skip pure wildcard aliases (`*`, `?*`) which are not real hosts.
      if (/[*?]/.test(alias)) continue;
      const host = current.host || alias;
      out.push({ id: alias, host, user: current.user, port: current.port, source: "ssh-config", alias });
    }
    current = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "host") {
      flush();
      current = { aliases: value.split(/\s+/) };
    } else if (current) {
      if (key === "hostname") current.host = value;
      else if (key === "user") current.user = value;
      else if (key === "port") { const n = Number(value); if (Number.isInteger(n) && n > 0) current.port = n; }
    }
  }
  flush();
  return out;
}

/** Extract unique host addresses from ~/.ssh/known_hosts (first field, comma lists, [host]:port). */
export function parseKnownHosts(text: string): DiscoveredHost[] {
  const seen = new Set<string>();
  const out: DiscoveredHost[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const first = line.split(/\s+/)[0];
    if (!first || first.startsWith("|")) continue; // skip hashed hostnames
    for (let part of first.split(",")) {
      let port: number | undefined;
      const p = /^\[(.+)\]:(\d+)$/.exec(part);
      if (p) { part = p[1]; port = Number(p[2]); }
      if (!part || /[*?]/.test(part)) continue;
      const key = `${part}:${port ?? 22}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: part, host: part, port, source: "known-hosts" });
    }
  }
  return out;
}

/** Which private keys exist locally (informational hint only). */
export function localKeys(): string[] {
  const dir = sshDir();
  const candidates = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsh_remote_ed25519"];
  return candidates.filter((name) => existsSync(join(dir, name)));
}

/** Full discovery: ssh config entries first (richer), then known_hosts-only addresses. */
export function discoverHosts(): { hosts: DiscoveredHost[]; keys: string[]; sshDir: string } {
  const dir = sshDir();
  const configHosts = parseSshConfig(readText(join(dir, "config")));
  const knownHosts = parseKnownHosts(readText(join(dir, "known_hosts")));
  const byAddress = new Map<string, DiscoveredHost>();
  for (const h of configHosts) byAddress.set(`${h.host}:${h.port ?? 22}`, h);
  for (const h of knownHosts) {
    const k = `${h.host}:${h.port ?? 22}`;
    if (!byAddress.has(k)) byAddress.set(k, h);
  }
  // Skip public service hosts (GitHub, GitLab…) — they are not computers to control.
  const SKIP = /^(github\.com|gitlab\.com|bitbucket\.org|ssh\.dev\.azure\.com)$/i;
  const hosts = [...byAddress.values()].filter((h) => !SKIP.test(h.host));
  return { hosts, keys: localKeys(), sshDir: dir };
}
