export function quickTunnelExpired(value) {
  return /Unauthorized:\s*Tunnel not found/i.test(String(value ?? ''));
}
