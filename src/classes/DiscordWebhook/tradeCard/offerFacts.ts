import { TradeOffer, Prices } from '@tf2autobot/tradeoffer-manager';
import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import pluralize from 'pluralize';
import Bot from '../../Bot';
import log from '../../../lib/logger';
import { currPure } from '../../../lib/tools/pure';

/**
 * What both halves of the trade summary read off an offer — the card and the
 * message body — so the two can never disagree about an item's worth, its
 * quantity, or where pure sorts.
 *
 * Deliberately free of `@napi-rs/canvas`: sendTradeSummary imports this
 * directly, and only reaches the canvas code through a lazy require so a broken
 * native binding costs the card rather than the summary.
 */

export const KEY_SKU = '5021;6';
export const METAL_SKUS = ['5002;6', '5001;6', '5000;6'];
/** Keys, then refined → scrap: the order the card's tiles and the item list both use. */
export const PURE_SKUS = [KEY_SKU, ...METAL_SKUS];

/** Poll data written before v3.0.0 stored `{ amount }` rather than a bare number. */
export function amountOf(raw: number | { amount: number }): number {
    return typeof raw === 'object' ? raw.amount ?? 0 : raw;
}

/**
 * Per-unit worth in scrap, used only for ordering. `prices` is written per-offer
 * so it still answers for autopriced items the pricelist no longer holds.
 */
export function unitValueOf(offer: TradeOffer, bot: Bot, keyRateMetal: number): (sku: string) => number {
    const prices = offer.data('prices') as Prices | undefined;

    return sku => {
        const priced = prices?.[sku]?.sell ?? bot.pricelist.getPrice({ priceKey: sku, onlyEnabled: false })?.sell;
        return priced ? new Currencies(priced).toValue(keyRateMetal) : 0;
    };
}

/** Milliseconds → `4.2s`, `3m 20s`, `2h 15m`, `1d 4h`. Short enough for a stat cell. */
export function formatDuration(ms: number): string {
    const seconds = ms / 1000;

    if (seconds < 60) {
        return `${Number(seconds.toFixed(1))}s`;
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    }
    if (seconds < 86400) {
        return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
    }

    return `${Math.floor(seconds / 86400)}d ${Math.round((seconds % 86400) / 3600)}h`;
}

/** One traded item at the prices it was bought and sold at. */
export interface PricedItem {
    name: string;
    buy: string;
    sell: string;
    /** Sell price in scrap, used only for ordering. */
    value: number;
}

/**
 * The priced items in a trade, most valuable first. A sku the schema cannot
 * name is skipped.
 *
 * Gated on `showItemPrices` here, in offerFacts, so the card's price section
 * and the text fallback read the same answer and cannot drift apart on the
 * toggle. The card disables the whole section by an empty array; `buildStatus`
 * and the verbose item list inherit the same gate through their own reads.
 */
export function collectPricedItems(offer: TradeOffer, bot: Bot, keyRateMetal: number): PricedItem[] {
    if (bot.options.tradeSummary?.showItemPrices === false) {
        return [];
    }

    const prices = offer.data('prices') as Prices | undefined;
    if (!prices) {
        return [];
    }

    const items: PricedItem[] = [];

    for (const sku of Object.keys(prices)) {
        const entry = prices[sku];
        if (!entry?.buy || !entry?.sell) {
            continue;
        }

        try {
            const sell = new Currencies(entry.sell);
            items.push({
                name: bot.schema.getName(SKU.fromString(sku), false),
                buy: new Currencies(entry.buy).toString(),
                sell: sell.toString(),
                value: sell.toValue(keyRateMetal)
            });
        } catch (err) {
            log.debug(`Could not name ${sku} for the trade summary prices: `, err);
        }
    }

    return items.sort((a, b) => b.value - a.value);
}

/** Overflow rows past this — a fifth slot spends itself on `+N more` instead. */
export const MAX_PRICE_ROWS = 5;

/**
 * The rows the price section will draw: name on the left, buy/sell on the
 * right. An overflow row spends the last slot on a count rather than a fourth
 * item. Lives here because the text fallback shapes prices the same way.
 */
export function priceRows(items: PricedItem[]): [string, string][] {
    const priced = (item: PricedItem): [string, string] => [item.name, `${item.buy} / ${item.sell}`];

    if (items.length <= MAX_PRICE_ROWS) {
        return items.map(priced);
    }

    const shown = items.slice(0, MAX_PRICE_ROWS - 1);
    const hidden = items.length - shown.length;

    return [...shown.map(priced), [`+${hidden} more priced ${hidden === 1 ? 'item' : 'items'}`, '']];
}

/**
 * The bot-side numbers a trade summary carries, as raw readings. The card and
 * the text fallback format the *same* readings, so they can never disagree
 * about which readings exist or which `misc.*` toggle gates them.
 *
 * Each reading carries its text label resolved here (customText verbatim, else
 * the built-in): the card runs it through `cardLabel`, the text uses it as is.
 */
export type StatReading =
    | {
          kind: 'keyRate';
          label: string;
          value: string;
          sub: string;
          note?: string;
      }
    | {
          kind: 'pureStock';
          label: string;
          value: string;
          sub: string;
      }
    | {
          kind: 'totalItems';
          label: string;
          value: string;
          sub?: string;
      }
    | {
          kind: 'timeTaken';
          label: string;
          /** Caption, human figure, raw ms — both renderers pick their own form. */
          rows: [string, string, number][];
          detailed: boolean;
          showMs: boolean;
      };

/** The subset of TradeCardMeta `collectStatReadings` needs; kept local so offerFacts imports no canvas. */
export interface StatMeta {
    timeTakenToComplete: number;
    timeTakenToProcessOrConstruct?: number;
    timeTakenToCounterOffer?: number;
    isOfferSent?: boolean;
}

const STAT_LABELS = {
    keyRate: '🔑 Key rate:',
    pureStock: '💰 Pure stock:',
    totalItems: '🎒 Total items:',
    timeTaken: '⏱ **Time taken:**'
};

/** Gate each reading exactly as the old embed's fields did. One place both renderers inherit. */
export function collectStatReadings(bot: Bot, meta: StatMeta): StatReading[] {
    const tSum = bot.options.tradeSummary;
    const customText = tSum?.customText;
    const misc = bot.options.discordWebhook?.tradeSummary?.misc;

    const readings: StatReading[] = [];

    if (misc?.showKeyRate) {
        const keyPrices = bot.pricelist.getKeyPrices;
        const autokeys = bot.handler.autokeys;
        const status = autokeys.getOverallStatus;

        readings.push({
            kind: 'keyRate',
            label: customText?.keyRate?.discordWebhook || STAT_LABELS.keyRate,
            value: `${keyPrices.buy.metal.toString()} / ${keyPrices.sell.metal.toString()} ref`,
            sub:
                keyPrices.src === 'manual'
                    ? 'manual'
                    : bot.pricelist.isUseCustomPricer
                    ? 'custom-pricer'
                    : 'PriceDB.IO',
            // Spelled out: "AK" means nothing without the options file to hand.
            note: autokeys.isEnabled
                ? autokeys.getActiveStatus
                    ? `Autokeys ${status.isBankingKeys ? 'bank' : status.isBuyingKeys ? 'buy' : 'sell'}`
                    : 'Autokeys idle'
                : undefined
        });
    }

    if (misc?.showPureStock) {
        const pure = currPure(bot);
        // A slash triple rather than the chat command's "380 ref, 26 rec, 11
        // scrap", which is twice as wide as a quarter-width box.
        const refined = Currencies.toRefined(pure.refTotalInScrap);

        readings.push({
            kind: 'pureStock',
            label: customText?.pureStock?.discordWebhook || STAT_LABELS.pureStock,
            value: `${pure.key} ${pluralize('key', pure.key)}`,
            sub: `${refined} ref (${pure.ref}/${pure.rec}/${pure.scrap})`
        });
    }

    if (misc?.showInventory) {
        const slots = bot.tf2.backpackSlots;
        readings.push({
            kind: 'totalItems',
            label: customText?.totalItems?.discordWebhook || STAT_LABELS.totalItems,
            value: `${bot.inventoryManager.getInventory.getTotalItems}`,
            sub: slots !== undefined ? `of ${slots} slots` : undefined
        });
    }

    // Captions are short because the box heading already says "time taken", and
    // the long form shrinks to nothing in a quarter-width column. `detailed` on
    // narrows the row set; the formatters let a single row read inline.
    const detailed = tSum?.showDetailedTimeTaken !== false;
    const showMs = tSum?.showTimeTakenInMS === true;
    const rows: [string, string, number][] = [];

    if (detailed) {
        if (meta.timeTakenToProcessOrConstruct !== undefined) {
            rows.push([
                meta.isOfferSent ? 'To construct' : 'To process',
                formatDuration(meta.timeTakenToProcessOrConstruct),
                meta.timeTakenToProcessOrConstruct
            ]);
        }

        if (meta.timeTakenToCounterOffer !== undefined) {
            rows.push(['To counter', formatDuration(meta.timeTakenToCounterOffer), meta.timeTakenToCounterOffer]);
        }
    }

    rows.push(['To complete', formatDuration(meta.timeTakenToComplete), meta.timeTakenToComplete]);

    readings.push({
        kind: 'timeTaken',
        label: customText?.timeTaken?.discordWebhook || STAT_LABELS.timeTaken,
        rows,
        detailed,
        showMs
    });

    // One row only: four columns is the grid the tiles already establish.
    return readings.slice(0, 4);
}
