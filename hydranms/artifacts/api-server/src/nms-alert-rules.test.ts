import assert from "node:assert/strict";
import test from "node:test";
import { detectInterfaceAlertEvents } from "./lib/nms-alert-rules";

const baseInterface = {
  ifIndex: 3,
  name: "sfp-sfpplus1",
  alias: "Uplink",
  adminStatus: "up",
  operStatus: "up",
  sfpVendor: "MikroTik",
  sfpSerialNumber: "SFP-001",
  opticalRxPower: -12.5,
  opticalTxPower: 1.2,
};

test("detects port down and SFP RX/TX changes", () => {
  const events = detectInterfaceAlertEvents(baseInterface, {
    ...baseInterface,
    operStatus: "down",
    opticalRxPower: -13.1,
    opticalTxPower: 1.4,
  });

  assert.deepEqual(events, [
    { kind: "port.down", ifIndex: 3, label: "sfp-sfpplus1" },
    { kind: "sfp.rx.changed", ifIndex: 3, label: "sfp-sfpplus1", previous: -12.5, current: -13.1 },
    { kind: "sfp.tx.changed", ifIndex: 3, label: "sfp-sfpplus1", previous: 1.2, current: 1.4 },
  ]);
});

test("detects SFP removal without treating the first poll as an incident", () => {
  assert.deepEqual(
    detectInterfaceAlertEvents(baseInterface, {
      ...baseInterface,
      sfpVendor: null,
      sfpSerialNumber: null,
      opticalRxPower: null,
      opticalTxPower: null,
    }),
    [{ kind: "sfp.removed", ifIndex: 3, label: "sfp-sfpplus1" }],
  );
  assert.deepEqual(
    detectInterfaceAlertEvents(
      {
        ...baseInterface,
        sfpVendor: null,
        sfpSerialNumber: null,
        opticalRxPower: null,
        opticalTxPower: null,
      },
      baseInterface,
    ),
    [{ kind: "sfp.inserted", ifIndex: 3, label: "sfp-sfpplus1" }],
  );
  assert.deepEqual(detectInterfaceAlertEvents(null, baseInterface), []);
});

test("does not alert for unchanged port or optical readings", () => {
  assert.deepEqual(detectInterfaceAlertEvents(baseInterface, baseInterface), []);
});