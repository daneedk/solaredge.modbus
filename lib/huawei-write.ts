import net from 'net';
import * as Modbus from 'jsmodbus';
import type Homey from 'homey';
import { inspect } from 'util';

const ATTEMPT_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 2000;
const REGISTERS: Record<string, number> = {
  storage_excess_pv_energy_use_in_tou: 47299,
  storage_force_charge_discharge: 47100,
  activepower_controlmode: 47415,
  remote_charge_discharge_control_mode: 47589,
  storage_working_mode_settings: 47086,
  battery_control: 40000,
  power_control_mode_at_grid: 40100,
};

function connectionError(message: string) {
  return Object.assign(new Error(message), { code: 'ECONNRESET' });
}

function canRetry(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const error = reason as { err?: string; code?: string };
  // Modbus exceptions (illegal address/value, permissions, etc.) are permanent.
  if (error.err === 'ModbusException') return false;
  return ['Offline', 'Timeout'].includes(error.err ?? '')
    || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code ?? '');
}

function writeAttempt(device: Homey.Device, unit: number, address: number, value: number, settleDelayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const client = new Modbus.client.TCP(socket, unit, ATTEMPT_TIMEOUT_MS);
    let finished = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseSettle: (() => void) | undefined;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      if (deadline) device.homey.clearTimeout(deadline);
      if (settleTimer) device.homey.clearTimeout(settleTimer);
      releaseSettle?.();
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(connectionError('Connection to Huawei Modbus server closed')));
    socket.once('connect', () => {
      // EventEmitter does not await promises: explicitly forward every failure.
      (async () => {
        if (finished) return;
        if (settleDelayMs) {
          await new Promise<void>((resume) => {
            releaseSettle = resume;
            settleTimer = device.homey.setTimeout(resume, settleDelayMs);
          });
        }
        if (finished) return;
        await client.writeSingleRegister(address, value);
        finish();
      })().catch(finish);
    });
    deadline = device.homey.setTimeout(() => {
      finish(Object.assign(new Error('Huawei write attempt timed out after 15 seconds'), { code: 'ETIMEDOUT' }));
    }, ATTEMPT_TIMEOUT_MS);
    try {
      socket.setKeepAlive(false);
      socket.connect({ host: device.getSetting('address'), port: Number(device.getSetting('port')) });
    } catch (error) {
      finish(error);
    }
  });
}

// Only mode-setting single-register writes use this bounded retry policy.
export default async function writeHuaweiRegister(
  device: Homey.Device, control: string, unit: number, value: number, settleDelayMs = 0,
): Promise<void> {
  const address = REGISTERS[control];
  if (address === undefined || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid Huawei write: ${control}=${value}`);
  }
  const context = `Huawei driver=${device.driver.id} device=${device.getData().id} name=${device.getName()} write=${control} unit=${unit}`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await writeAttempt(device, unit, address, value, settleDelayMs);
      return;
    } catch (reason) {
      if (attempt === 1 && canRetry(reason)) {
        device.log(`${context}: retrying in 2 seconds`, inspect(reason, { depth: 4, customInspect: false, getters: false }));
        await new Promise<void>((resolve) => device.homey.setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        const details = inspect(reason, {
          depth: 4, maxArrayLength: 16, maxStringLength: 2000, customInspect: false, getters: false,
        });
        const error = new Error(`Huawei command could not be confirmed (${control}, unit ${unit}). ${context} attempt=${attempt}: ${details}`);
        Object.defineProperty(error, 'cause', { value: reason });
        throw error;
      }
    }
  }
}
