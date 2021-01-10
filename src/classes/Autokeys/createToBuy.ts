import Currencies from 'tf2-currencies';

import { genScrapAdjustment } from './userSettings';

import Bot from '../Bot';
import { EntryData, PricelistChangedSource } from '../Pricelist';

import log from '../../lib/logger';

export default function createToBuy(minKeys: number, maxKeys: number, bot: Bot): void {
    const opt = bot.options;

    const scrapAdjustment = genScrapAdjustment(opt.autokeys.scrapAdjustment.value, opt.autokeys.scrapAdjustment.enable);
    const keyPrices = bot.pricelist.getKeyPrices();
    let entry;

    if (keyPrices.src !== 'manual' && !scrapAdjustment.enabled) {
        entry = {
            sku: '5021;6',
            enabled: true,
            autoprice: true,
            min: minKeys,
            max: maxKeys,
            intent: 0,
            note: {
                buy: opt.details.buy.replace(/⚡️𝘧𝘢𝘴𝘵 𝘵𝘳𝘢𝘥𝘪𝘯𝘨⚡️/g, '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬]'),
                sell: opt.details.sell.replace(/⚡️𝘧𝘢𝘴𝘵 𝘵𝘳𝘢𝘥𝘪𝘯𝘨⚡️/g, '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬]')
            }
        } as EntryData;
    } else if (keyPrices.src === 'manual' && !scrapAdjustment.enabled) {
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
            intent: 0,
            note: {
                buy: opt.details.buy.replace(/⚡️𝘧𝘢𝘴𝘵 𝘵𝘳𝘢𝘥𝘪𝘯𝘨⚡️/g, '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬]'),
                sell: opt.details.sell.replace(/⚡️𝘧𝘢𝘴𝘵 𝘵𝘳𝘢𝘥𝘪𝘯𝘨⚡️/g, '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬]')
            }
        } as EntryData;
    } else if (scrapAdjustment.enabled) {
        entry = {
            sku: '5021;6',
            enabled: true,
            autoprice: false,
            sell: {
                keys: 0,
                metal: Currencies.toRefined(keyPrices.sell.toValue() + scrapAdjustment.value)
            },
            buy: {
                keys: 0,
                metal: Currencies.toRefined(keyPrices.buy.toValue() + scrapAdjustment.value)
            },
            min: minKeys,
            max: maxKeys,
            intent: 0,
            note: {
                buy: opt.details.buy.replace(/⚡️𝘧𝘢𝘴𝘵 𝘵𝘳𝘢𝘥𝘪𝘯𝘨⚡️/g, '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬]'),
                sell: opt.details.sell.replace(/⚡️𝘧𝘢𝘴𝘵 𝘵𝘳𝘢𝘥𝘪𝘯𝘨⚡️/g, '[𝐀𝐮𝐭𝐨𝐤𝐞𝐲𝐬]')
            }
        } as EntryData;
    }
    bot.pricelist
        .addPrice(entry, true, PricelistChangedSource.Autokeys)
        .then(() => {
            log.debug(`✅ Automatically added Mann Co. Supply Crate Key to buy.`);
        })
        .catch((err: Error) => {
            log.warn(`❌ Failed to add Mann Co. Supply Crate Key to buy automatically: ${err.message}`);
        });
}
