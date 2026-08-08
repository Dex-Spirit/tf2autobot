import { TradeOffer, Prices } from '@tf2autobot/tradeoffer-manager';
import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import Bot from '../../Bot';
import log from '../../../lib/logger';

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

/** The priced items in a trade, most valuable first. A sku the schema cannot name is skipped. */
export function collectPricedItems(offer: TradeOffer, bot: Bot, keyRateMetal: number): PricedItem[] {
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
