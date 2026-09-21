export function formatCounter(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed.toLocaleString('en-IN') : value;
}

export function formatPower(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(2)} dBm`;
}

type InterfaceState = string | number | null | undefined;

function normalizedInterfaceState(value: InterfaceState): string | null {
  if (value === null || value === undefined) return null;
  const state = String(value).trim().toLowerCase();
  if (state === '1' || state === 'up') return 'up';
  if (state === '2' || state === 'down') return 'down';
  return state || null;
}

export function formatInterfaceState(adminStatus: InterfaceState, operStatus: InterfaceState): string {
  const state = normalizedInterfaceState(operStatus) ?? normalizedInterfaceState(adminStatus);
  return state ? state.toUpperCase() : 'UNKNOWN';
}

export function interfaceStatus(adminStatus: InterfaceState, operStatus: InterfaceState) {
  const normalizedAdmin = normalizedInterfaceState(adminStatus);
  const normalizedOper = normalizedInterfaceState(operStatus);
  if (normalizedOper === 'up') return 'online';
  if (normalizedAdmin === 'down' || normalizedOper === 'down') return 'offline';
  return 'warning';
}