/** Fan-out de eventos a los WebSockets abiertos de cada usuario. */
export interface Socket { deviceId: string; send(data: string): void }

export class Hub {
  private byUser = new Map<string, Set<Socket>>();

  add(userId: string, s: Socket) {
    let set = this.byUser.get(userId);
    if (!set) this.byUser.set(userId, (set = new Set()));
    set.add(s);
  }
  remove(userId: string, s: Socket) {
    const set = this.byUser.get(userId);
    set?.delete(s);
    if (set && set.size === 0) this.byUser.delete(userId);
  }
  emit(userId: string, event: Record<string, unknown>, onlyDevice?: string) {
    const set = this.byUser.get(userId);
    if (!set) return;
    const data = JSON.stringify(event);
    for (const s of set) if (!onlyDevice || s.deviceId === onlyDevice) {
      try { s.send(data); } catch { /* socket cerrándose */ }
    }
  }
  connectedDevices(userId: string): Set<string> {
    return new Set([...(this.byUser.get(userId) ?? [])].map(s => s.deviceId));
  }
  closeDevice(userId: string, deviceId: string) {
    for (const s of this.byUser.get(userId) ?? []) if (s.deviceId === deviceId) (s as Socket & { close?: () => void }).close?.();
  }
}
