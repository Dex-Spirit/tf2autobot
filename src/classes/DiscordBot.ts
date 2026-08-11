/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */

import {
    Client,
    GatewayIntentBits,
    Message,
    DiscordAPIError,
    Snowflake,
    ActivityType,
    ApplicationCommandType,
    TextChannel,
    MessageFlagsBitField,
    MessageCreateOptions,
    ButtonInteraction
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import log from '../lib/logger';
import Options from './Options';
import Bot from './Bot';
import SteamID from 'steamid';
import { uptime } from '../lib/tools/time';
import { CurrentPure, stock as pureStock } from '../lib/tools/pure';
import renderPureStockCard from './DiscordWebhook/tradeCard/renderPureStockCard';
import { renderStockCardPage, stockCardPageCount } from './DiscordWebhook/tradeCard/renderStockCards';
import type { StockCardEntry } from './DiscordWebhook/tradeCard/renderStockCards';
import renderSkuChart from './DiscordWebhook/tradeCard/renderSkuChart';

const STOCK_PAGER_TIMEOUT_MS = 15 * 60 * 1000;

interface StockPagerSession {
    requesterId: Snowflake;
    entries: StockCardEntry[];
    title: string;
    currentPage: number;
    totalPages: number;
    detailsText?: string;
    message: Message;
}

export default class DiscordBot {
    readonly client: Client;

    private prefix = '!';

    private MAX_MESSAGE_LENGTH = 2000 - 2; // some characters are reserved

    private readonly stockPagers = new Map<string, StockPagerSession>();

    constructor(private options: Options, private bot: Bot) {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        // 'ready' binding should be executed BEFORE the login() is complete
        /* eslint-disable */
        this.client.on('ready', this.onClientReady.bind(this));
        this.client.on('messageCreate', async message => this.onMessage(message));
        /* eslint-enable */
        this.prefix = this.bot.options.miscSettings?.prefixes?.discord ?? this.prefix;
    }

    public async start(): Promise<void> {
        try {
            await this.client.login(this.options.discordBotToken);
            await this.client.application.commands.set([
                {
                    name: 'uptime',
                    description: 'Show bot uptime',
                    type: ApplicationCommandType.ChatInput
                }
            ]);

            /* eslint-disable */
            this.client.on('interactionCreate', async interaction => {
                if (interaction.isButton() && interaction.customId.startsWith('stock-page:')) {
                    await this.handleStockPager(interaction);
                    return;
                }

                if (!interaction.isChatInputCommand()) return;

                if (interaction.commandName === 'uptime') {
                    await interaction.reply({ content: uptime() });
                }
            });
            /* eslint-enable */
        } catch (err) {
            const error = err as DiscordAPIError;

            if (error.code && error.code.toString() === 'TOKEN_INVALID') {
                log.error('Failed to login to Discord: bot token is invalid.');
                throw error; // only "incorrect token" error should crash the bot, so "throw" is only here
            } else {
                log.error('Failed to login to Discord, please use Steam chat for now. Error summary:', error);
                this.admins.forEach(admin => {
                    this.bot.sendMessage(
                        admin,
                        'Failed to log in to Discord. You can still use commands in here.\n' +
                            `If https://discordstat.us doesn't indicate any problems right now, you can try to restart.\n` +
                            `If restarting didn't fix the problem - please ask for help on TF2Autobot Discord server: https://pricedb.io/discord`
                    );
                });
            }
        }
    }

    public stop(): void {
        log.info('Logging out from Discord...');
        void this.client.destroy();
    }

    public async onMessage(message: Message): Promise<void> {
        if (message.author === this.client.user) {
            return; // don't talk to myself
        }

        if (message.webhookId) {
            return; // Ignore webhook messages
        }

        if (!message.content.startsWith(this.prefix)) {
            return; // Ignore message that not start with !
        }

        log.info(
            `Got new message ${String(message.content)} from ${message.author.tag} (${String(message.author.id)})`
        );

        if (!this.bot.isReady) {
            this.sendAnswer(message, '🛑 The bot is still booting up, please wait');
            return;
        }

        try {
            if (!this.isDiscordAdmin(message.author.id)) {
                // Will return default invalid value
                const dummySteamID = new SteamID(null);
                dummySteamID.redirectAnswerTo = message;
                await this.bot.handler.onMessage(dummySteamID, message.content);
                return;
            }

            const adminID = this.getAdminBy(message.author.id);
            adminID.redirectAnswerTo = message;
            await this.bot.handler.onMessage(adminID, message.content);
        } catch (err) {
            log.error(err);
            (message.channel as TextChannel)
                .send(`❌ Error:\n${JSON.stringify(err)}`)
                .catch(err => log.error('Failed to send error message to Discord:', err));
        }
    }

    private static reformat(message: string): string {
        if (message.startsWith('/code')) {
            return '```json\n' + message.slice(6) + '\n```';
        } else if (message.startsWith('/pre2')) {
            return '```\n' + message.slice(5) + '\n```';
        } else if (message.startsWith('/pre')) {
            return '>>> ' + message.slice(5);
        } else {
            return message;
        }
    }

    public sendAnswer(origMessage: Message, messageToSend: string): void {
        messageToSend = messageToSend.trim();
        const formattedMessage = DiscordBot.reformat(messageToSend);

        if (messageToSend == formattedMessage) {
            const lines = messageToSend.split('\n');
            let partialMessage = '';
            for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i];
                if (partialMessage.length + 1 + line.length <= this.MAX_MESSAGE_LENGTH) {
                    if (i == 0) {
                        partialMessage += line;
                    } else {
                        partialMessage += '\n' + line;
                    }
                } else {
                    this.sendMessage(origMessage, partialMessage);
                    partialMessage = line; // Error is still possible if any line is longer than limit
                }
            }
            this.sendMessage(origMessage, partialMessage);
        } else {
            this.sendMessage(origMessage, formattedMessage); // TODO: normal parsing of markup things
        }
    }

    public async sendV2TextAnswer(origMessage: Message, title: string, body: string): Promise<void> {
        try {
            await (origMessage.channel as TextChannel).send({
                flags: MessageFlagsBitField.Flags.IsComponentsV2,
                components: [
                    {
                        type: 17,
                        accent_color: Number(this.bot.options.discordWebhook.embedColor),
                        components: [{ type: 10, content: `## ${title}\n${body}` }]
                    }
                ] as unknown as MessageCreateOptions['components']
            });
        } catch (err) {
            log.warn('Failed to send Discord Components V2 text response:', err);
            this.sendAnswer(origMessage, `${title}\n${body}`);
        }
    }

    public async sendSkuAnswer(origMessage: Message, name: string, sku: string): Promise<void> {
        const chart = await renderSkuChart(sku, this.bot.pricelist.getKeyPrices.sell.metal);
        const components = [
            {
                type: 17,
                accent_color: Number(this.bot.options.discordWebhook.embedColor),
                components: [
                    { type: 10, content: `## 🏷️ ${name}\n**SKU:** \`${sku}\`` },
                    ...(chart ? [{ type: 12, items: [{ media: { url: 'attachment://sku-history.png' } }] }] : [])
                ]
            },
            {
                type: 1,
                components: [{ type: 2, style: 5, label: 'Open PriceDB item', url: `https://pricedb.io/item/${sku}` }]
            }
        ] as unknown as MessageCreateOptions['components'];

        try {
            await (origMessage.channel as TextChannel).send({
                flags: MessageFlagsBitField.Flags.IsComponentsV2,
                components,
                files: chart ? [{ attachment: chart, name: 'sku-history.png' }] : []
            });
        } catch (err) {
            log.warn('Failed to send Discord SKU card:', err);
            this.sendAnswer(origMessage, `• ${name}\nhttps://pricedb.io/item/${sku}`);
        }
    }

    public async sendPureStockAnswer(origMessage: Message, stock: CurrentPure): Promise<void> {
        const fallback = `💰 I have ${pureStock(this.bot).join(' and ')} in my inventory.`;
        const card = await renderPureStockCard(stock, this.bot.options.steamAccountName);
        if (card === null) {
            this.sendAnswer(origMessage, fallback);
            return;
        }

        await this.sendCardGallery(origMessage, [card], 'pure-stock', fallback);
    }

    public async sendStockGalleryAnswer(
        origMessage: Message,
        entries: StockCardEntry[],
        title: string,
        fallback: string,
        detailsText?: string
    ): Promise<void> {
        const totalPages = stockCardPageCount(entries);
        const card = await renderStockCardPage(entries, this.bot.options.steamAccountName, title, 0);
        if (card === null) {
            this.sendAnswer(origMessage, fallback);
            return;
        }

        try {
            const token = randomUUID();
            const session = {
                requesterId: origMessage.author.id,
                entries,
                title,
                currentPage: 0,
                totalPages,
                detailsText
            } as Omit<StockPagerSession, 'message'>;
            const message = await (origMessage.channel as TextChannel).send({
                flags: MessageFlagsBitField.Flags.IsComponentsV2,
                components: this.stockPagerComponents(session, token),
                files: [{ attachment: card, name: 'stock-page.png' }]
            });

            if (totalPages > 1) {
                this.stockPagers.set(token, { ...session, message });
                setTimeout(() => void this.expireStockPager(token), STOCK_PAGER_TIMEOUT_MS);
            }
        } catch (err) {
            log.warn('Failed to send Discord stock card; sending text fallback:', err);
            this.sendAnswer(origMessage, fallback);
        }
    }

    private stockPagerComponents(
        session: Pick<StockPagerSession, 'currentPage' | 'totalPages' | 'detailsText'>,
        token?: string,
        expired = false
    ): MessageCreateOptions['components'] {
        const container = {
            type: 17,
            accent_color: Number(this.bot.options.discordWebhook.embedColor),
            components: [
                { type: 12, items: [{ media: { url: 'attachment://stock-page.png' } }] },
                ...(session.detailsText ? [{ type: 10, content: session.detailsText }] : [])
            ]
        };

        if (expired) {
            return [
                container,
                {
                    type: 1,
                    components: [
                        {
                            type: 2,
                            style: 2,
                            label: 'Results expired — rerun !stock',
                            custom_id: 'stock-page:expired',
                            disabled: true
                        }
                    ]
                }
            ] as unknown as MessageCreateOptions['components'];
        }

        if (session.totalPages <= 1 || token === undefined)
            return [container] as unknown as MessageCreateOptions['components'];

        return [
            container,
            {
                type: 1,
                components: [
                    {
                        type: 2,
                        style: 2,
                        label: '◀ Previous',
                        custom_id: `stock-page:${token}:previous`,
                        disabled: session.currentPage === 0
                    },
                    {
                        type: 2,
                        style: 2,
                        label: `Page ${session.currentPage + 1} / ${session.totalPages}`,
                        custom_id: `stock-page:${token}:current`,
                        disabled: true
                    },
                    {
                        type: 2,
                        style: 2,
                        label: 'Next ▶',
                        custom_id: `stock-page:${token}:next`,
                        disabled: session.currentPage === session.totalPages - 1
                    }
                ]
            }
        ] as unknown as MessageCreateOptions['components'];
    }

    private async handleStockPager(interaction: ButtonInteraction): Promise<void> {
        const [, token, direction] = interaction.customId.split(':');
        const session = this.stockPagers.get(token);
        if (session === undefined || direction === undefined || direction === 'current') {
            await interaction.reply({
                content: 'This stock result has expired. Please rerun !stock.',
                flags: MessageFlagsBitField.Flags.Ephemeral
            });
            return;
        }

        if (interaction.user.id !== session.requesterId && !this.isDiscordAdmin(interaction.user.id)) {
            await interaction.reply({
                content: 'Only the requester or a bot admin can browse this result.',
                flags: MessageFlagsBitField.Flags.Ephemeral
            });
            return;
        }

        const page = direction === 'next' ? session.currentPage + 1 : session.currentPage - 1;
        if (page < 0 || page >= session.totalPages) {
            await interaction.deferUpdate();
            return;
        }

        await interaction.deferUpdate();
        const card = await renderStockCardPage(session.entries, this.bot.options.steamAccountName, session.title, page);
        if (card === null) return;

        session.currentPage = page;
        await session.message.edit({
            components: this.stockPagerComponents(session, token),
            attachments: [],
            files: [{ attachment: card, name: 'stock-page.png' }]
        });
    }

    private async expireStockPager(token: string): Promise<void> {
        const session = this.stockPagers.get(token);
        if (session === undefined) return;

        this.stockPagers.delete(token);
        try {
            await session.message.edit({ components: this.stockPagerComponents(session, undefined, true) });
        } catch (err) {
            log.debug('Failed to expire Discord stock pager:', err);
        }
    }

    private async sendCardGallery(
        origMessage: Message,
        cards: Buffer[],
        name: string,
        fallback: string
    ): Promise<boolean> {
        try {
            for (let offset = 0; offset < cards.length; offset += 10) {
                const batch = cards.slice(offset, offset + 10);
                const files = batch.map((card, index) => ({
                    attachment: card,
                    name: `${name}-${offset + index + 1}.png`
                }));
                const components = [
                    {
                        type: 17,
                        accent_color: Number(this.bot.options.discordWebhook.embedColor),
                        components: [
                            {
                                type: 12,
                                items: files.map(file => ({ media: { url: `attachment://${file.name}` } }))
                            }
                        ]
                    }
                ] as unknown as MessageCreateOptions['components'];

                await (origMessage.channel as TextChannel).send({
                    flags: MessageFlagsBitField.Flags.IsComponentsV2,
                    components,
                    files
                });
            }
            return true;
        } catch (err) {
            log.warn('Failed to send Discord card gallery; sending text fallback:', err);
            this.sendAnswer(origMessage, fallback);
            return false;
        }
    }

    private sendMessage(origMessage: Message, message: string): void {
        if (message.startsWith('\n')) {
            message = '.' + message;
        }
        if (message.endsWith('\n')) {
            message = message + '.';
        }

        (origMessage.channel as TextChannel)
            .send(message)
            .then(() => log.info(`Message sent to ${origMessage.author.tag} (${origMessage.author.id}): ${message}`))
            .catch((err: any) => log.error('Failed to send message to Discord:', err));
    }

    private async onClientReady() {
        log.info(
            `Logged in to Discord as ${String(this.client.user.tag)} to serve on ${
                this.client.guilds.cache.size
            } servers.`
        );
        this.client.user.setStatus('idle');

        // I don't use try-catch here since the bot has to crash if something went wrong
        this.validateAdmins();

        // DM chats won't emit messageCreate until the first usage. This thing fetches required DM chats.
        for (const admin of this.admins) {
            const adminUser = await this.client.users.fetch(admin.discordID).catch(err => {
                log.error('Failed to fetch admin by id:', err);
            });
            if (adminUser && !adminUser.bot) {
                this.client.users.createDM(adminUser).catch(err => {
                    log.error('Failed to fetch DM channel with admin:', err);
                });
            }
        }
    }

    setPresence(type: 'online' | 'halt'): void {
        const opt = this.bot.options.discordChat[type];

        /* eslint-disable */
        this.client?.user?.setPresence({
            activities: [
                {
                    name: opt.name,
                    type:
                        typeof opt.type === 'string'
                            ? ActivityType[capitalizeFirstLetter(opt.type.toLowerCase())]
                            : opt.type
                }
            ],
            status: opt.status
        });
        /* eslint-enable */
    }

    halt(): void {
        this.setPresence('halt');
    }

    unhalt(): void {
        this.setPresence('online');
    }

    isDiscordAdmin(discordID: Snowflake): boolean {
        return this.bot.getAdmins.some(admin => admin.discordID === discordID);
    }

    get admins(): SteamID[] {
        return this.bot.getAdmins.filter(admin => admin.discordID);
    }

    private validateAdmins(): void {
        const uniqueAdmins = new Set<Snowflake>();
        this.admins.forEach(admin => {
            const discordID = admin.discordID;
            if (uniqueAdmins.has(discordID)) {
                throw Error(`ADMINS contains more than one entry with discordID ${discordID}`);
            }
            uniqueAdmins.add(discordID);
        });
    }

    private getAdminBy(discordID: Snowflake): SteamID {
        // Intended to use with all checks made before. Throwing errors just to be sure.

        if (!this.isDiscordAdmin(discordID)) {
            throw Error(`Admin with discordID ${discordID} was not found`);
        }

        const result = this.admins.filter(admin => admin.discordID === discordID);
        return result[0];
    }
}

function capitalizeFirstLetter(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
