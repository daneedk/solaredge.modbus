const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
let clock;
let sockets;
let writes;
let plans;

class Clock {
  now = 0;
  next = 1;
  timers = new Map();
  setTimeout = (fn, ms) => {
    const id = this.next++;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async tick(ms) {
    const end = this.now + ms;
    await flush();
    while (true) {
      const entry = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      this.now = entry[1].at;
      this.timers.delete(entry[0]);
      entry[1].fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}
class Socket extends EventEmitter {
  constructor() { super(); sockets.push(this); this.plan = plans.shift() || {}; }
  setKeepAlive() {}
  connect(options) {
    this.options = options;
    queueMicrotask(() => {
      if (this.plan.connectError) this.emit('error', this.plan.connectError);
      else if (!this.plan.noConnect) this.emit('connect');
    });
  }
  destroy() { this.destroyed = true; this.emit('close'); }
}
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'homey') return { Device: class {} };
  if (name === 'net') return { Socket };
  if (name === 'jsmodbus') return { client: { TCP: class {
    constructor(socket, unit, timeout) { this.socket = socket; this.unit = unit; assert.equal(timeout, 15000); }
    async writeSingleRegister(address, value) {
      writes.push({ address, value, unit: this.unit, at: clock.now });
      if (this.socket.plan.close) { this.socket.emit('close'); return new Promise(() => {}); }
      if (this.socket.plan.error) throw this.socket.plan.error;
      if (this.socket.plan.pending) return this.socket.plan.pending;
      if (this.socket.plan.hang) return new Promise(() => {});
      return { response: {} };
    }
  } } };
  return originalLoad.call(this, name, ...args);
};
const write = require('../lib/huawei-write').default;
const drivers = Object.fromEntries(['huaweiwithbatt', 'huaweidouble', 'huaweiwithemma'].map((id) => [id, require(`../drivers/${id}/device`)]));
Module._load = originalLoad;

function setup(id = 'huaweiwithbatt', steps = [{}]) {
  clock = new Clock(); sockets = []; writes = []; plans = [...steps];
  const device = new drivers[id]();
  device.driver = { id };
  device.getData = () => ({ id: 'test-device' });
  device.getName = () => 'Test Huawei';
  device.getSetting = (key) => ({ id: id === 'huaweiwithemma' ? 0 : 1, address: '127.0.0.1', port: 502 })[key];
  device.log = () => {};
  device.hasCapability = () => true;
  device.pollInvertor = () => {};
  device.actions = new Map(); device.controls = new Map();
  device.registerCapabilityListener = (id, fn) => device.controls.set(id, fn);
  device.homey = {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: () => 1,
    flow: { getActionCard: (id) => ({ registerRunListener: (fn) => device.actions.set(id, fn) }) },
  };
  return device;
}
function observe(promise) {
  const result = { state: 'pending' };
  promise.then(() => { result.state = 'fulfilled'; }, (error) => { result.state = 'rejected'; result.error = error; });
  return result;
}
function clean() {
  assert.ok(sockets.every((socket) => socket.destroyed), 'all attempt sockets destroyed');
  assert.equal(clock.timers.size, 0, 'all attempt timers cleared');
}

async function main() {
  // A successful Flow remains pending until the actual Modbus acknowledgement.
  let acknowledge;
  let device = setup('huaweiwithbatt', [{ pending: new Promise((resolve) => { acknowledge = resolve; }) }]);
  await device.onInit();
  let result = observe(device.actions.get('storage_force_charge_discharge_main')({ device, mode: 0 }));
  await flush(); assert.equal(result.state, 'pending');
  acknowledge({ response: {} }); await flush();
  assert.equal(result.state, 'fulfilled');
  assert.deepEqual(writes[0], { address: 47100, value: 0, unit: 1, at: 0 }); clean();

  // Offline rejection retries the identical write once, after exactly 2 seconds.
  device = setup('huaweiwithemma', [{ error: { err: 'Offline', message: 'no connection to modbus server' } }, {}]);
  result = observe(write(device, 'power_control_mode_at_grid', 0, 7));
  await clock.tick(1999); assert.equal(sockets.length, 1); assert.equal(result.state, 'pending');
  await clock.tick(1); assert.equal(result.state, 'fulfilled'); assert.equal(sockets.length, 2);
  assert.notEqual(sockets[0], sockets[1]);
  assert.deepEqual(writes.map(({ address, value, unit }) => [address, value, unit]), [[40100, 7, 0], [40100, 7, 0]]); clean();

  // Connection errors before connect and premature closes also retry once.
  for (const first of [{ connectError: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }, { close: true }]) {
    device = setup('huaweiwithbatt', [first, {}]);
    result = observe(write(device, 'storage_working_mode_settings', 1, 4));
    await clock.tick(2000); assert.equal(result.state, 'fulfilled'); assert.equal(sockets.length, 2); clean();
  }

  // Both a stalled connection and a stalled response are bounded at 32 seconds total.
  for (const plan of [{ noConnect: true }, { hang: true }]) {
    device = setup('huaweiwithbatt', [plan, plan]);
    await device.onInit();
    result = observe(device.actions.get('storage_working_mode_settings_main')({ device, mode: 4 }));
    await clock.tick(14999); assert.equal(sockets.length, 1); assert.equal(result.state, 'pending');
    await clock.tick(1); assert.ok(sockets[0].destroyed);
    await clock.tick(2000); assert.equal(sockets.length, 2);
    await clock.tick(14999); assert.equal(result.state, 'pending');
    await clock.tick(1); assert.equal(result.state, 'rejected');
    assert.match(result.error.message, /Huawei command could not be confirmed/);
    assert.match(result.error.message, /driver=huaweiwithbatt.*write=storage_working_mode_settings.*unit=1.*attempt=2/); clean();
  }

  // A late response from the expired first socket cannot complete the second attempt.
  let firstAck; let secondAck;
  device = setup('huaweiwithbatt', [
    { pending: new Promise((resolve) => { firstAck = resolve; }) },
    { pending: new Promise((resolve) => { secondAck = resolve; }) },
  ]);
  result = observe(write(device, 'storage_force_charge_discharge', 1, 0));
  await clock.tick(17000);
  firstAck({ response: {} }); await flush(); assert.equal(result.state, 'pending');
  secondAck({ response: {} }); await flush(); assert.equal(result.state, 'fulfilled'); clean();

  // Protocol/validation errors never retry and reach the Flow with their cause.
  const exception = { err: 'ModbusException', message: 'Illegal data value' };
  device = setup('huaweiwithemma', [{ error: exception }]); await device.onInit();
  result = observe(device.actions.get('battery_control')({ device, mode: 2 })); await flush();
  assert.equal(result.state, 'rejected'); assert.equal(result.error.cause, exception);
  assert.equal(sockets.length, 1); clean();
  await assert.rejects(write(device, 'battery_control', 0, NaN), /Invalid Huawei write/);
  await assert.rejects(write(device, 'unknown', 0, 2), /Invalid Huawei write/);
  assert.equal(sockets.length, 1);

  // Preserve each driver's addresses/unit routing, including the double inverter's settling delay.
  for (const id of Object.keys(drivers)) {
    device = setup(id); await device.onInit();
    const emma = id === 'huaweiwithemma'; const double = id === 'huaweidouble';
    const card = emma ? 'battery_control' : double ? 'storage_force_charge_discharge2' : 'storage_force_charge_discharge_main';
    result = observe(device.actions.get(card)({ device, deviceid: 2, mode: emma ? 2 : 0 }));
    await flush();
    if (double) { assert.equal(writes.length, 0); await clock.tick(4999); assert.equal(writes.length, 0); await clock.tick(1); }
    assert.equal(result.state, 'fulfilled');
    assert.equal(writes[0].address, emma ? 40000 : 47100);
    assert.equal(writes[0].unit, double ? 2 : emma ? 0 : 1); clean();
  }

  // Device controls must also await failure instead of reporting early success.
  device = setup('huaweiwithbatt', [{ error: exception }]); await device.onInit();
  result = observe(device.controls.get('storage_force_charge_discharge')(0)); await flush();
  assert.equal(result.state, 'rejected'); clean();
  console.log('Huawei writes: acknowledgement, fresh connection retry/delay, 32s deadline, error propagation, no protocol retry, all write drivers and cleanup passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
