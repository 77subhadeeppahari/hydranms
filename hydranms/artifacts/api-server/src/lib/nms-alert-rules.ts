export type InterfaceAlertSnapshot = {
  ifIndex: number;
  name: string;
  alias?: string | null;
  adminStatus: string | null;
  operStatus: string | null;
  sfpVendor: string | null;
  sfpSerialNumber: string | null;
  opticalRxPower: number | null;
  opticalTxPower: number | null;
};

export type InterfaceAlertEvent =
  | { kind: "port.up" | "port.down"; ifIndex: number; label: string }
  | { kind: "sfp.removed" | "sfp.inserted"; ifIndex: number; label: string }
  | { kind: "sfp.rx.changed" | "sfp.tx.changed"; ifIndex: number; label: string; previous: number; current: number };

function normalizedState(value: string | null | undefined): "up" | "down" | null {
  const state = value?.trim().toLowerCase();
  if (state === "1" || state === "up") return "up";
  if (state === "2" || state === "down") return "down";
  return null;
}

function portState(snapshot: InterfaceAlertSnapshot): "up" | "down" | null {
  return normalizedState(snapshot.operStatus) ?? normalizedState(snapshot.adminStatus);
}

function hasSfp(snapshot: InterfaceAlertSnapshot): boolean {
  return Boolean(
    snapshot.sfpVendor ||
      snapshot.sfpSerialNumber ||
      snapshot.opticalRxPower !== null ||
      snapshot.opticalTxPower !== null,
  );
}

export function interfaceLabel(snapshot: Pick<InterfaceAlertSnapshot, "ifIndex" | "name" | "alias">): string {
  return snapshot.name || snapshot.alias || `Port ${snapshot.ifIndex}`;
}

export function detectInterfaceAlertEvents(
  previous: InterfaceAlertSnapshot | null,
  current: InterfaceAlertSnapshot,
): InterfaceAlertEvent[] {
  if (!previous) return [];

  const events: InterfaceAlertEvent[] = [];
  const previousState = portState(previous);
  const currentState = portState(current);
  const label = interfaceLabel(current);

  if (previousState && currentState && previousState !== currentState) {
    events.push({ kind: `port.${currentState}`, ifIndex: current.ifIndex, label });
  }

  if (hasSfp(previous) && !hasSfp(current)) {
    events.push({ kind: "sfp.removed", ifIndex: current.ifIndex, label });
  }

  if (!hasSfp(previous) && hasSfp(current)) {
    events.push({ kind: "sfp.inserted", ifIndex: current.ifIndex, label });
  }

  if (
    previous.opticalRxPower !== null &&
    current.opticalRxPower !== null &&
    previous.opticalRxPower !== current.opticalRxPower
  ) {
    events.push({
      kind: "sfp.rx.changed",
      ifIndex: current.ifIndex,
      label,
      previous: previous.opticalRxPower,
      current: current.opticalRxPower,
    });
  }

  if (
    previous.opticalTxPower !== null &&
    current.opticalTxPower !== null &&
    previous.opticalTxPower !== current.opticalTxPower
  ) {
    events.push({
      kind: "sfp.tx.changed",
      ifIndex: current.ifIndex,
      label,
      previous: previous.opticalTxPower,
      current: current.opticalTxPower,
    });
  }

  return events;
}