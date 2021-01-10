import Bot from '../Bot';
import { EntryData, PricelistChangedSource } from '../Pricelist';

import log from '../../lib/logger';

export default function createToBank(minKeys: number, maxKeys: number, bot: Bot): void {
    const keyPrices = bot.pricelist.getKeyPrices();
    const opt = bot.options;
    let entry;

    if (keyPrices.src !== 'manual') {
        entry = {
            sku: '5021;6',
            enabled: true,
            autoprice: true,
            min: minKeys,
            max: maxKeys,
            intent: 2,
            note: {
                buy: opt.details.buy.replace(/⚡️𝘧𝘢𝘴𝘵 𝘵𝘳𝘢𝘥𝘪𝘯𝘨⚡️/g, '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬]'),
                sell: opt.details.sell.replace(/⚡️𝘧𝘢𝘴𝘵 𝘵𝘳𝘢𝘥𝘪𝘯𝘨⚡️/g, '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬]')
            }
        } as EntryData;
    } else {
        entry = {
            sku: '5021;6',
            enabled: true,
            autoprice: false,
            sell: {
                keys: 0,
                metal: keyPrices.sell.metal
            },
            buy: {
                keys: 0,
                metal: keyPrices.buy.metal
            },
            min: minKeys,
            max: maxKeys,
            intent: 2,
            note: {
                buy: opt.details.buy.replace(/⚡️𝘧𝘢𝘴𝘵 𝘵𝘳𝘢𝘥𝘪𝘯𝘨⚡️/g, '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬]'),
                sell: opt.details.sell.replace(/⚡️𝘧𝘢𝘴𝘵 𝘵𝘳𝘢𝘥𝘪𝘯𝘨⚡️/g, '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬]')
            }
        } as EntryData;
    }
    bot.pricelist
        .addPrice(entry, true, PricelistChangedSource.Autokeys)
        .then(() => {
            log.debug(`✅ Automatically added Mann Co. Supply Crate Key to bank.`);
        })
        .catch((err: Error) => {
            log.warn(`❌ Failed to add Mann Co. Supply Crate Key to bank automatically: ${err.message}`);
        });
}
