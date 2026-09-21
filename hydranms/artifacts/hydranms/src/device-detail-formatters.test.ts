import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCounter, formatInterfaceState, formatPower, interfaceStatus } from './device-detail-formatters';

test('formats nullable interface counters safely', () => {
  assert.equal(formatCounter(null), '—');
  assert.equal(formatCounter(undefined), '—');
  assert.equal(formatCounter('123456789'), '12,34,56,789');
  assert.equal(formatCounter('counter-value'), 'counter-value');
});

test('formats nullable RX and TX optical power safely', () => {
  assert.equal(formatPower(null), '—');
  assert.equal(formatPower(undefined), '—');
  assert.equal(formatPower(-18.256), '-18.26 dBm');
  assert.equal(formatPower(0), '0.00 dBm');
});

test('maps incomplete interface status readings without throwing', () => {
  assert.equal(interfaceStatus(null, null), 'warning');
  assert.equal(interfaceStatus('up', null), 'warning');
  assert.equal(interfaceStatus(null, 'up'), 'online');
  assert.equal(interfaceStatus('down', null), 'offline');
});

test('converts numeric SNMP interface states to readable port states', () => {
  assert.equal(formatInterfaceState('1', '1'), 'UP');
  assert.equal(formatInterfaceState('2', '2'), 'DOWN');
  assert.equal(formatInterfaceState(null, null), 'UNKNOWN');
  assert.equal(interfaceStatus('1', '1'), 'online');
  assert.equal(interfaceStatus('2', '2'), 'offline');
});