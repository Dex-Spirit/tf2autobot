/* eslint @typescript-eslint/no-unsafe-call: 1 */
/* eslint @typescript-eslint/no-unsafe-member-access: 1 */
import { IPC } from 'node-ipc';
import log from '../lib/logger';
import Bot from './Bot';
import fs from 'fs';
import path from 'path';
import Options from './Options';
import generateCert from '../lib/tools/generateCert';

export default class ipcHandler extends IPC {
    ourServer: any;

    bot: Bot;

    options: Options;

    privateKey?: string;

    publicKey?: string;

    serverCert?: string;

    caCert?: string;

    constructor(bot: Bot) {
        super();
        this.server = null;
        this.bot = bot;
        this.options = bot.options;
        if (this.options.tls) {
            this.publicKey = path.join(__dirname, `../../files/${this.bot.options.steamAccountName}/client.pub`);
            this.privateKey = path.join(__dirname, `../../files/${this.bot.options.steamAccountName}/client.key`);
            this.serverCert = path.join(__dirname, `../../files/${this.bot.options.steamAccountName}/server.pem`);
            this.caCert = path.join(__dirname, `../../files/${this.bot.options.steamAccountName}/ca.pem`);
        }
    }

    init(): void {
        this.config.id = this.bot.client.steamID.getSteamID64();
        this.config.retry = 15000;
        //this.config.silent = true;

        if (this.options.tls) {
            this.config.networkHost = this.options.tlsHost;
            this.config.networkPort = this.options.tlsPort;
            if (!fs.existsSync(this.publicKey) || !fs.existsSync(this.privateKey)) {
                const { certificate, privateKey } = generateCert();
                fs.writeFileSync(this.publicKey, certificate);
                fs.writeFileSync(this.privateKey, privateKey);
            }

            if (!fs.existsSync(this.serverCert) || !fs.existsSync(this.caCert)) {
                log.error('Servers public key not found');
                throw new Error('Servers public key not found');
            }
            this.config.tls = {
                private: this.privateKey,
                public: this.publicKey,
                trustedConnections: this.serverCert,
                ca: fs.readFileSync(this.caCert)
            } as Record<string, unknown>; //Ignore TS once again
        }

        // eslint-disable-next-line
        this.connectToNet('autobot_gui_dev', () => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-assignment
            this.ourServer = this.of.autobot_gui_dev;
            log.debug('connected IPC');

            //bind handlers
            this.ourServer.on('connect', this.connected.bind(this));
            this.ourServer.on('getInfo', this.sendInfo.bind(this));
            this.ourServer.on('getPricelist', this.sendPricelist.bind(this));
            this.ourServer.on('disconnected', this.disconnected.bind(this));
            this.ourServer.on('addItem', this.addItem.bind(this));
            this.ourServer.on('updateItem', this.updateItem.bind(this));
            this.ourServer.on('removeItem', this.removeItem.bind(this));
            this.ourServer.on('getTrades', this.sendTrades.bind(this));
            this.ourServer.on('sendChat', this.sendChat.bind(this));
        });
    }

    private static cleanItem(item): void {
        if (item?.name) delete item.name;
        if (item?.time) delete item.time;
        if (item?.statslink) delete item.statslink;
        if (item?.style) delete item.style;
    }

    /* HANDLERS */
    private addItem(item): void {
        ipcHandler.cleanItem(item);

        this.bot.pricelist
            .addPrice(item, true)
            .then(item => {
                this.ourServer.emit('itemAdded', item);
            })
            .catch((e: string) => {
                this.ourServer.emit('itemAdded', e);
            });
    }

    private updateItem(item): void {
        ipcHandler.cleanItem(item);
        this.bot.pricelist
            .updatePrice(item, true)
            .then(item => {
                this.ourServer.emit('itemUpdated', item);
            })
            .catch((e: string) => {
                this.ourServer.emit('itemUpdated', e);
            });
    }

    private removeItem(sku: string): void {
        this.bot.pricelist
            .removePrice(sku, true)
            .then(item => {
                this.ourServer.emit('itemRemoved', item);
            })
            .catch((e: string) => {
                this.ourServer.emit('itemRemoved', e);
            });
    }

    private connected(): void {
        log.info('IPC connected');
    }

    private disconnected(): void {
        log.warn('IPC disconnect');
    }

    private sendInfo(): void {
        this.ourServer.emit('info', {
            id: this.bot.client.steamID.getSteamID64(),
            admins: this.bot.getAdmins.map(id => id.getSteamID64())
        });
    }

    sendPricelist(): void {
        if (this.bot.pricelist) this.ourServer.emit('pricelist', this.bot.pricelist.getPrices);
        else this.ourServer.emit('pricelist', false);
    }

    sendTrades(): void {
        this.ourServer.emit('polldata', this.bot.manager.pollData);
    }

    private sendChat(message: string): void {
        this.bot.handler
            .onMessage(this.bot.getAdmins[0], message, false)
            .then(msg => {
                this.ourServer.emit('chatResp', msg);
            })
            .catch((e: string) => {
                this.ourServer.emit('chatResp', e);
            });
    }
}
