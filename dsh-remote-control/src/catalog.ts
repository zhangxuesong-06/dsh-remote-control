import { RemoteClient, type HealthInfo } from "./agent-http.js";
import type { RemoteMachine } from "./registry.js";

export interface HostStatus {
  checkedAt: number;
  online: boolean;
  text: string;
  health?: HealthInfo;
}

/** Runtime-only observations. Configuration/credentials changing always invalidate a cached result. */
export class HostCatalog {
  private cache = new Map<string, { key: string; status: HostStatus }>();
  private pending = new Map<string, Promise<HostStatus>>();
  constructor(private observed: (machine: RemoteMachine, health: HealthInfo) => void, readonly ttlMs = 15_000) {}
  private key(machine: RemoteMachine): string {
    return JSON.stringify([machine.id, machine.host, machine.port, machine.paths, machine.tunnelUrl,
      machine.token, machine.tokenSha256, machine.enabled]);
  }
  peek(machine: RemoteMachine): HostStatus | undefined {
    const item = this.cache.get(machine.id);
    return item?.key === this.key(machine) ? item.status : undefined;
  }
  forget(id: string): void { this.cache.delete(id); }
  async probe(machine: RemoteMachine, timeoutMs: number, refresh = false): Promise<HostStatus> {
    const key = this.key(machine);
    const cached = this.peek(machine);
    if (!refresh && cached && Date.now() - cached.checkedAt < this.ttlMs) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const promise = (async (): Promise<HostStatus> => {
      let status: HostStatus;
      try {
        const health = await new RemoteClient(machine).health(timeoutMs);
        status = { checkedAt: Date.now(), online: true, text: `在线 v${health.version} (${health.hostname}, ${health.platform})`, health };
        try { this.observed(machine, health); } catch { /* Observation persistence cannot invalidate a live connection. */ }
      } catch (error) {
        status = { checkedAt: Date.now(), online: false, text: error instanceof Error ? error.message : String(error) };
      }
      this.cache.set(machine.id, { key, status });
      return status;
    })();
    this.pending.set(key, promise);
    try { return await promise; } finally { this.pending.delete(key); }
  }
}
