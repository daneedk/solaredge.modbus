import writeHuaweiRegister from '../../lib/huawei-write';
// eslint-disable-next-line node/no-missing-import
import withErrorContext from '../../lib/error-context';
import * as Modbus from 'jsmodbus';
import net from 'net';
import Homey, { Device } from 'homey';
import { checkHoldingRegisterHuaweiEmma } from '../response';
import { Huawei } from '../huawei';

const RETRY_INTERVAL = 25 * 1000;

class MyHuaweiEmmaDevice extends Huawei {
  timer!: NodeJS.Timer;
  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyHuaweiEmmaDevice has been initialized');

    const name = this.getData().id;
    this.log(`device name id ${name}`);
    this.log(`device name ${this.getName()}`);

    if (this.hasCapability('meter_power.daily_charge') === false) {
      await this.addCapability('meter_power.daily_charge');
    }

    if (this.hasCapability('meter_power.daily_discharge') === false) {
      await this.addCapability('meter_power.daily_discharge');
    }
    if (this.hasCapability('meter_power.total_charge') === false) {
      await this.addCapability('meter_power.total_charge');
    }

    if (this.hasCapability('meter_power.total_discharge') === false) {
      await this.addCapability('meter_power.total_discharge');
    }

    if (this.hasCapability('meter_power.grid_import_total') === false) {
      await this.addCapability('meter_power.grid_import_total');
    }

    if (this.hasCapability('meter_power.grid_export_total') === false) {
      await this.addCapability('meter_power.grid_export_total');
    }

    this.pollInvertor();

    this.timer = this.homey.setInterval(() => {
      // poll device state from inverter
      this.pollInvertor();
    }, RETRY_INTERVAL);

    // homey menu / device actions
    this.registerCapabilityListener('battery_control', async (value) => {
      await this.updateControl('battery_control', Number(value), this);
      return value;
    });
    this.registerCapabilityListener('power_control_mode_at_grid', async (value) => {
      await this.updateControl('power_control_mode_at_grid', Number(value), this);
      return value;
    });

    const controlBatteryControl = this.homey.flow.getActionCard('battery_control');
    controlBatteryControl.registerRunListener(async (args, state) => {
      const name = this.getData().id;
      this.log(`device name id ${name}`);
      this.log(`device name ${this.getName()}`);
      this.log(args.device.getName());
      await this.updateControl('battery_control', Number(args.mode), args.device);
    });

    const controlpowerControlModeAtGrid = this.homey.flow.getActionCard('power_control_mode_at_grid');
    controlpowerControlModeAtGrid.registerRunListener(async (args, state) => {
      const name = this.getData().id;
      this.log(`device name id ${name}`);
      this.log(`device name ${this.getName()}`);
      this.log(args.device.getName());
      await this.updateControl('power_control_mode_at_grid', Number(args.mode), args.device);
    });
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyHuaweiEmmaDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings: {}, newSettings: {}, changedKeys: {} }): Promise<string | void> {
    this.log('MyHuaweiEmmaDevice settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('MyHuaweiEmmaDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyHuaweiEmmaDevice has been deleted');
    this.homey.clearInterval(this.timer);
  }

  delay(ms: any) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async updateControl(type: string, value: number, device: Homey.Device) {
    await writeHuaweiRegister(device, type, Number(device.getSetting('id')), value);
  }

  async pollInvertor() {
    this.log('pollInvertor');
    this.log(this.getSetting('address'));

    const modbusOptions = {
      host: this.getSetting('address'),
      port: this.getSetting('port'),
      unitId: this.getSetting('id'),
      timeout: 27,
      autoReconnect: false,
      logLabel: 'huawei Inverter',
      logLevel: 'error',
      logEnabled: true,
    };

    const socket = new net.Socket();
    const unitID = this.getSetting('id');
    const client = new Modbus.client.TCP(socket, unitID, 1500);
    socket.setKeepAlive(false);
    socket.connect(modbusOptions);

    const errorContext = `Huawei driver=${this.driver.id} device=${this.getData().id} name=${this.getName()} poll unit=${unitID}`;
    socket.on('connect', withErrorContext(errorContext, async () => {
      console.log('Connected ...');
      console.log(modbusOptions);
      const startTime = new Date();
      await this.delay(1000);

      const checkRegisterRes = await checkHoldingRegisterHuaweiEmma(this.holdingEmmaRegisters, client);

      console.log('disconnect');
      client.socket.end();
      socket.end();
      const finalRes = { ...checkRegisterRes };
      await this.processEmmaResult(finalRes);
      const endTime = new Date();
      const timeDiff = endTime.getTime() - startTime.getTime();
      const seconds = Math.floor(timeDiff / 1000);
      console.log(`total time: ${seconds} seconds`);
    }));

    socket.on('close', () => {
      console.log('Client closed');
    });

    socket.on('timeout', () => {
      console.log('socket timed out!');
      client.socket.end();
      socket.end();
    });

    socket.on('error', (err) => {
      console.log(err);
      client.socket.end();
      socket.end();
    });
  }
}

module.exports = MyHuaweiEmmaDevice;
