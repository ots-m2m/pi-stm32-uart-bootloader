import wpi = require('node-wiring-pi');
import SerialPort = require("serialport");
import BufferBuilder = require('buffer-builder');
import NestedError = require('nested-error-stacks');
import events = require('events');
import hexy = require('hexy');

const BOOT0_MAIN_FLASH = 0;
const BOOT0_SYSTEM_MEMORY = 1;

const WRITE_PACKET_SIZE = 256;
const READ_PACKET_SIZE = 0xff;

const CMD_GET = 0x00;
const CMD_GET_VERSION = 0x01;
const CMD_ID = 0x02;
const CMD_READ_MEMORY = 0x11;
const CMD_GO = 0x21;
const CMD_WRITE_MEMORY = 0x31;
const CMD_ERASE = 0x43;
const CMD_EXTENDED_ERASE = 0x44;
const CMD_WRITE_PROTECT = 0x63;
const CMD_WRITE_UNPROTECT = 0x73;
const CMD_READOUT_PROTECT = 0x82;
const CMD_READOUT_UNPROTECT = 0x92;

const ACK = 0x79;
const NACK = 0x1f;

export interface Stm32UartBootloaderOptions {
    resetPin: number;
    boot0Pin: number;
    serialPortPath: string;
    serialPortBaudRate?: number;
}

declare interface Stm32UartBootloaderEvent {
    on(event: 'flash-progress', listener: (address: number, current: number, total: number) => void): this;

    on(event: string, listener: Function): this;
}

export class Stm32UartBootloader extends events.EventEmitter implements Stm32UartBootloaderEvent {
    private resetPin: number;
    private boot0Pin: number;
    private serialPortPath: string;
    private serialPortBaudRate: number;
    private initCalled: boolean;
    private serialPort: SerialPort;
    private pid: number;
    private bootloaderVersion: number;
    private availableCommands: number[];

    constructor(options: Stm32UartBootloaderOptions) {
        super();
        this.resetPin = options.resetPin;
        this.boot0Pin = options.boot0Pin;
        this.serialPortPath = options.serialPortPath;
        this.serialPortBaudRate = options.serialPortBaudRate || 115200;
    }

    async init() {
        if (!this.initCalled) {
            try {
                wpi.pinMode(this.boot0Pin, wpi.OUTPUT);

                await this._setBoot0MainFlash();
                await this._deassertReset();
                this.initCalled = true;
            } catch (err) {
                throw new NestedError('could not initialize', err);
            }
        }
    }

    private async _setBoot0MainFlash() {
        wpi.digitalWrite(this.boot0Pin, BOOT0_MAIN_FLASH);
    }

    private async _setBoot0SystemMemory() {
        wpi.digitalWrite(this.boot0Pin, BOOT0_SYSTEM_MEMORY);
    }

    private async _deassertReset() {
        wpi.digitalWrite(this.resetPin, 0);
        wpi.pinMode(this.resetPin, wpi.OUTPUT);
    }

    private async _assertReset() {
        wpi.digitalWrite(this.resetPin, 1);
        wpi.pinMode(this.resetPin, wpi.OUTPUT);
    }

    private async _openSerialPort() {
        this.serialPort = new SerialPort(this.serialPortPath, {
            baudRate: this.serialPortBaudRate,
            dataBits: 8,
            parity: 'even',
            stopBits: 1,
            autoOpen: false
        }, false);
        return new Promise((resolve, reject) => {
            this.serialPort.open((err) => {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });
    }

    private async _flushSerialPort() {
        return new Promise((resolve, reject) => {
            this.serialPort.flush((err,results)=>{
                if (err) {
                    return reject(err);
                }
                resolve();
            });
            resolve();
        });
    }

    private async _closeSerialPort() {
        if (!this.serialPort) {
            return;
        }

        return new Promise((resolve, reject) => {
            this.serialPort.removeAllListeners('data');
            this.serialPort.close((err) => {
                this.serialPort = null;
                if (err && err.message.indexOf('Port is not open') >= 0) {
                    err = null;
                }
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });
    }

    private static _calculateChecksumOfBuffer(buffer: Buffer) {
        let checksum = 0x00;
        for (let i = 0; i < buffer.length; i++) {
            checksum = checksum ^ buffer[i];
        }
        return checksum;
    }

    private async _cmdWrite(address: number, data: Buffer) {
        const STATE = {
            SEND_ADDRESS: 0,
            SEND_DATA: 1,
            WAIT_FOR_DATA_ACK: 2,
            COMPLETE: 3,
            ERROR: 4
        };

        const addr0 = (address >> 24) & 0xff;
        const addr1 = (address >> 16) & 0xff;
        const addr2 = (address >> 8) & 0xff;
        const addr3 = (address >> 0) & 0xff;
        const addrChecksum = addr0 ^ addr1 ^ addr2 ^ addr3;
        let buffer;
        let state = STATE.SEND_ADDRESS;
        if (!this._cmdIsAvailable(CMD_WRITE_MEMORY)) {
            throw new Error('write memory command not available');
        }
        return this._withTimeoutAndData(
            (callback) => {
                this.serialPort.write(new Buffer([CMD_WRITE_MEMORY, ~CMD_WRITE_MEMORY]), callback);
            },
            (rx, callback) => {
                switch (state) {
                    case STATE.SEND_ADDRESS:
                        if (rx[0] !== ACK) {
                            state = STATE.ERROR;
                            return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                        }
                        state = STATE.SEND_DATA;
                        buffer = new Buffer([addr0, addr1, addr2, addr3, addrChecksum]);

                        return this.serialPort.write(buffer, (err) => {
                            if (err) {
                                return callback(err);
                            }
                        });

                    case STATE.SEND_DATA:
                        if (rx[0] !== ACK) {
                            state = STATE.ERROR;
                            return callback(new Error('Expected address ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                        }
                        state = STATE.WAIT_FOR_DATA_ACK;
                        buffer = Buffer.alloc(1 + data.length + 1);
                        buffer[0] = data.length - 1;
                        data.copy(buffer, 1, 0);
                        buffer[buffer.length - 1] = buffer[0] ^ Stm32UartBootloader._calculateChecksumOfBuffer(data);
                        return this.serialPort.write(buffer, (err) => {
                            if (err) {
                                return callback(err);
                            }
                        });

                    case STATE.WAIT_FOR_DATA_ACK:
                        if (rx[0] !== ACK) {
                            state = STATE.ERROR;
                            return callback(new Error('Expected data ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                        }
                        state = STATE.COMPLETE;
                        return callback();
                }
            },
            30 * 1000
        );
    }

    private async _cmdRead(address: number, pages: number)
    {
        const STATE = {
            SEND_ADDRESS: 0,
            SEND_LENGTH: 1,
            WAIT_FOR_DATA_ACK: 2,
            RECEIVE_DATA: 3,
            COMPLETE: 4,
            ERROR: 5,
            GATHERING_DATA: 6
        };
        var response;
        var offset = 0;

        let offest = 0;
        let read_address = address;
        let buffer;
        let this_command_bytes = 0;
        let state = STATE.SEND_ADDRESS;
        if (!this._cmdIsAvailable(CMD_READ_MEMORY)) {
            throw new Error('read memory command not available');
        }
        return this._withTimeoutAndData(
            (callback) => {

                this.serialPort.write(new Buffer([CMD_READ_MEMORY, ~CMD_READ_MEMORY]), callback);
            },
            (rx, callback) => {
                switch (state) {

                    case STATE.SEND_ADDRESS:
                        if (rx[0] !== ACK) {
                            state = STATE.ERROR;
                            return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                        }
                        state = STATE.SEND_LENGTH;

                        read_address = address + offest;
                        console.log("reading from 0x" + read_address.toString(16));
                        const addr0 = (read_address >> 24) & 0xff;
                        const addr1 = (read_address >> 16) & 0xff;
                        const addr2 = (read_address >> 8) & 0xff;
                        const addr3 = (read_address >> 0) & 0xff;
                        const addrChecksum = addr0 ^ addr1 ^ addr2 ^ addr3;
                        buffer = new Buffer([addr0, addr1, addr2, addr3, addrChecksum]);
                        this_command_bytes = 0;

                        response = Buffer.alloc(256);

                        return this.serialPort.write(buffer, (err) => {
                            if (err) {
                                return callback(err);
                            }
                        });

                    case STATE.SEND_LENGTH:
                        if (rx[0] !== ACK) {
                            state = STATE.ERROR;
                            return callback(new Error('Expected address ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                        }
                        state = STATE.WAIT_FOR_DATA_ACK;
                        buffer = new Buffer([READ_PACKET_SIZE, ~READ_PACKET_SIZE]);

                        return this.serialPort.write(buffer, (err) => {
                            if (err) {
                                return callback(err);
                            }
                        });

                    case STATE.WAIT_FOR_DATA_ACK:
                        if (rx[0] !== ACK) {
                            state = STATE.ERROR;
                            return callback(new Error('Expected address ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                        }
                        rx = rx.slice(1);

                        state = STATE.GATHERING_DATA;
                        //fall through to next case is on purpose!
                    case STATE.GATHERING_DATA:

                        rx.copy(response, this_command_bytes, 0,  rx.length);

                        offset += rx.length;
                        this_command_bytes += rx.length;

console.log("rx.length: " + rx.length + " this_command_bytes: " + this_command_bytes)

                        if (this_command_bytes == 256)
                        {

                        var format = { "offset" : read_address };
                        console.log(hexy.hexy(response, format));
                        console.log("finished");
                            if (offset < pages * 0xff)
                            {
                              console.log("more");
                              setTimeout(()=>{
                                state = STATE.SEND_ADDRESS;
                                buffer = new Buffer([CMD_READ_MEMORY, ~CMD_WRITE_MEMORY]);
                                return this.serialPort.write(buffer, (err) => {
                                    if (err) {
                                        return callback(err);
                                    }
                                });
                             },500);
                            }
                            else
                            {
                                state = STATE.COMPLETE;
                                return callback();
                            }
                        }

                }
            },
            30 * 1000
        );
    }

    private async _writeAll(startAddress: number, data: Buffer) {
        let address = startAddress;
        let offset = 0;
        const length = data.length + (4 - (data.length % 4));
        while (offset < length) {
            const packet = Buffer.alloc(WRITE_PACKET_SIZE, 0xff);
            data.copy(packet, 0, offset);
            await this._cmdWrite(address, packet);
            this.emit('flash-progress', address, offset, length);
            address += packet.length;
            offset += packet.length;
        }
    }

    async eraseAll() {
        return this._runSystemMemoryFn(async () => {
            await this._cmdEraseAll();
        });
    }
    async eraseBlocks(blocks) {
        return this._runSystemMemoryFn(async () => {
            await this._cmdEraseBlocks(blocks);
        });
    }

    async go(address: number) {
        return this._runSystemMemoryFn(async () => {
            await this._go(address);
        });
    }

    async reset(address: number) {
        await this._assertReset();
        await this._setBoot0MainFlash();
        await Stm32UartBootloader._sleep(1000);
        await this._deassertReset();
    }

    async read(address: number, pages: number) {
        return this._runSystemMemoryFn(async () => {
            await this._cmdRead(address, pages);
        });
    }

    async flash(address: number, data: Buffer) {
        return this._runSystemMemoryFn(async () => {
            await this._writeAll(address, data);
        });
    }

    private async _withTimeoutAndData<T>(
        begin: (callback: Function) => void,
        onData: (data: Buffer, done: Function) => void,
        timeoutMS: number
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const self = this;

            let _try = (c) => {
                if (c != 0) console.log("try " + c);
                const timeout = setTimeout(() => {
                    this.serialPort.removeAllListeners('data');
                    done(timeoutError);
                    if (c < 10) _try(c+1);
                }, timeoutMS);

                let callbackCalled = false;
                const done = (function _done(err, arg) {
                    clearTimeout(timeout);
                    self.serialPort.removeAllListeners('data');
                    if (!callbackCalled) {
                        callbackCalled = true;
                        if (err) {
                            return reject(err);
                        }
                        return resolve(arg);
                    }
                }).bind(this);

                const timeoutError = new Error('Timeout waiting for response');

                this.serialPort.on('data', (data) => {
                    onData(data, done);
                });

                this._flushSerialPort().then(()=>{
                    begin((err) => {
                        if (err) {
                            done(err);
                        }
                    });
                });
            }
            _try(0);
        });
    }

    private static async _sleep(ms: number) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    private async _go(address: number)
    {
        const addr0 = (address >> 24) & 0xff;
        const addr1 = (address >> 16) & 0xff;
        const addr2 = (address >> 8) & 0xff;
        const addr3 = (address >> 0) & 0xff;
        const addrChecksum = addr0 ^ addr1 ^ addr2 ^ addr3;
        let buffer;

        return this._withTimeoutAndData(
            (callback) => {
                this.serialPort.write(new Buffer([CMD_GO, ~CMD_GO]), callback);
            },
            (rx, callback) => {
                if (rx[0] !== ACK) {
                    return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + rx[0].toString(16)));
                }
                buffer = new Buffer([addr0, addr1, addr2, addr3, addrChecksum]);

                return this.serialPort.write(buffer, (err) => {
                    if (err) {
                        return callback(err);
                    }
                });
            },
            1000
        );
    }

    private async _enterBootloader() {
        return this._withTimeoutAndData(
            (callback) => {
                this.serialPort.write(new Buffer([0x7f]), callback);
            },
            (data, callback) => {
                if (data.length !== 1) {
                    return callback(new Error('Enter Bootloader: Expected length 1 found ' + data.length));
                }
                if (data[0] !== 0x79) {
                    return callback(new Error('Enter Bootloader: Expected 0x79 found 0x' + data[0].toString(16)));
                }
                return callback();
            },
            1000
        );
    }

    private _cmdIsAvailable(cmd: number) {
        return this.availableCommands.indexOf(cmd) >= 0;
    }

    private async _getIdCmd() {
        if (!this._cmdIsAvailable(CMD_ID)) {
            throw new Error('ID command not available');
        }
        const buffer = await this._cmdWithAckBeginAndEnd(CMD_ID);
        this.pid = (buffer[2] << 8) | buffer[3];
        return this.pid;
    }

    private async _getCmd() {
        const buffer = await this._cmdWithAckBeginAndEnd(CMD_GET);
        this.bootloaderVersion = buffer[2];
        this.availableCommands = [];
        for (let i = 3; i < buffer.length - 1; i++) {
            this.availableCommands.push(buffer[i]);
        }
    }

    private async _cmdWithAckBeginAndEnd(cmd: number): Promise<BufferBuilder> {
        let buffer = new BufferBuilder();
        let len = -1;
        return this._withTimeoutAndData<BufferBuilder>(
            (callback) => {

                this.serialPort.write(new Buffer([cmd, ~cmd]), callback);
            },
            (data, callback) => {
                if (buffer.length === 0 && data[0] !== ACK) {
                    return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
                }
                buffer.appendBuffer(data);
                if (buffer.length > 2 && len < 0) {
                    len = buffer.get()[1] + 4;
                }
                if (buffer.length === len) {
                    buffer = buffer.get();
                    if (buffer[buffer.length - 1] !== ACK) {
                        return callback(new Error('Expected end ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
                    }

                    return callback(null, buffer);
                }
            },
            500
        );
    }

    private async _cmdEraseBlocks(blocks)
    {
        let len = 0;
        let command = CMD_ERASE;
        if (!this._cmdIsAvailable(CMD_ERASE))
        {
            if (!this._cmdIsAvailable(CMD_EXTENDED_ERASE))
            {
                throw new Error('Erase command not available');
            }
            else
            {
                command = CMD_EXTENDED_ERASE;
            }
        }
        return this._withTimeoutAndData(
            (callback) => {
                this.serialPort.write(new Buffer([command, ~command]), callback);
            },
            (data, callback) => {
                if (data[0] !== ACK) {
                    return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
                }
                len += data.length;
                if (len === 2) {
                    return callback();
                }

                let buffer = Buffer.alloc(2);
                let cs = Buffer.alloc(1);

                if (command == CMD_EXTENDED_ERASE)
                {
                    buffer = Buffer.alloc(2 + (blocks.length* 2));
                    let offset = 0;
                    buffer.writeUInt16BE(blocks.length - 1, offset);
                    offset += 2;

                    blocks.forEach((block)=>{
                        buffer.writeUInt16BE(block, offset);
                        offset += 2;
                    });

                    cs.writeUInt8(Stm32UartBootloader._calculateChecksumOfBuffer(buffer), 0);
                }
                let b = Buffer.concat([buffer, cs])

                this.serialPort.write(b, (err) => {
                    if (err) {
                        return callback(err);
                    }
                });
            },
            30 * 1000
        );
    }
    private async _cmdEraseAll() {
        let len = 0;
        let command = CMD_ERASE;
        if (!this._cmdIsAvailable(CMD_ERASE)) {
            if (!this._cmdIsAvailable(CMD_EXTENDED_ERASE)) {
                throw new Error('Erase command not available');
            }
            else
            {
                command = CMD_EXTENDED_ERASE;
            }
        }
        return this._withTimeoutAndData(
            (callback) => {
                this.serialPort.write(new Buffer([command, ~command]), callback);
            },
            (data, callback) => {
                if (data[0] !== ACK) {
                    return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
                }
                len += data.length;
                if (len === 2) {
                    return callback();
                }
                let num_pages =[0xff, 0x00];
                if (command == CMD_EXTENDED_ERASE)
                {
                    num_pages = [0xff, 0xff, 0x00];
                }
                this.serialPort.write(new Buffer(num_pages), (err) => {
                    if (err) {
                        return callback(err);
                    }
                });
            },
            30 * 1000
        );
    }

    private async _runSystemMemoryFn(fn: Function) {
        try {
            await this._openSerialPort();

            for (let i = 0; i < 100; i++)
            {
                try
                {
                    console.log("trying...");
                    await this._assertReset();
                    await this._setBoot0SystemMemory();
                    await Stm32UartBootloader._sleep(100);
                    await this._deassertReset();
                    await Stm32UartBootloader._sleep(1000);
                    await this._enterBootloader();

                    break;
                }
                catch (e)
                {
                    if (i > 100) throw e;
                }
            }

            console.log("bootloader connected");

            await this._getCmd();
            await this._getIdCmd();
            await fn();
            await this._assertReset();
            await this._setBoot0MainFlash();
        } finally {
            await this._closeSerialPort();
            await this._deassertReset();
        }
    }
}