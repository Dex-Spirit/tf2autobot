import { TradeOffer, ItemsDict, ItemsValue, OurTheirItemsDict } from '@tf2autobot/tradeoffer-manager';
import pluralize from 'pluralize';
import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import { getPartnerDetails, sendWebhook, WebhookAttachment } from './utils';
import { Container, Webhook } from './interfaces';
import log from '../../lib/logger';
import * as t from '../../lib/tools/export';
import Bot from '../Bot';
import { sendToAdmin } from '../MyHandler/offer/accepted/processAccepted';
import type { FIFOEntry } from '../InventoryCostBasis';
import type { TradeCardMeta, TradeCardOptions } from './tradeCard';
// A direct import, unlike ./tradeCard below: offerFacts pulls in no native
// canvas binding, so it cannot be the thing that costs us the summary.
import {
    amountOf,
    collectPricedItems,
    collectStatReadings,
    formatDuration,
    KEY_SKU,
    METAL_SKUS,
    PricedItem,
    priceRows,
    PURE_SKUS,
    StatReading,
    unitValueOf
} from './tradeCard/offerFacts';

/** `IS_COMPONENTS_V2` — required on any message that sets `components`. */
const COMPONENTS_V2_FLAG = 1 << 15;

/**
 * Discord's ceiling on combined Text Display content across the whole message
 * (down from the embed's 6000 = 4096 description + 2048 footer). Fixed blocks
 * (header, detail, subtext) are built first; whatever is left funds the item
 * link blocks, which degrade in stages rather than truncate mid-link.
 */
const TOTAL_TEXT_BUDGET = 4000;
const BUDGET_SAFETY_MARGIN = 150;

const MESSAGE_CAP = 180;
const NAME_CAP = 34;
/**
 * Item names run in full unless the budget forces otherwise — "Professional
 * Killstreak Sharp Dresser" is 37 characters and a legitimate item, not an
 * outlier. This is the ceiling once that degradation stage kicks in, sized so
 * an unusual effect plus a killstreak tier still survives.
 */
const TIGHT_NAME_CAP = 42;
/** 10 a side keeps the worst case inside the budget before degradation kicks in. */
const MAX_LINKED_ITEMS = 10;

/** High value attributes are worth spelling out, so they get lines rather than a count. */
const MAX_HIGH_VALUE_LINES = 3;
const HIGH_VALUE_LINE_CAP = 240;
/** Past a handful of sales the block stops being read, so it aggregates instead. */
const MAX_PROFIT_LINES = 3;
/**
 * The floor the fixed blocks (detail + status + header + subtext) must leave
 * before the verbose detail form is allowed: roughly one side block's worth, so
 * the item links never starve just because XML-style flagged names got roomy.
 */
const MIN_LINK_BUDGET = 800;

export default async function sendTradeSummary(
    offer: TradeOffer,
    accepted: Accepted,
    bot: Bot,
    timeTakenToComplete: number,
    timeTakenToProcessOrConstruct: number,
    timeTakenToCounterOffer: number,
    isOfferSent: boolean,
    isAcceptedWithEscrow: boolean
): Promise<void> {
    const optBot = bot.options;
    const optDW = optBot.discordWebhook;

    // `showProperName` off abbreviates qualities — "Professional Killstreak"
    // becomes "Pro KS" — which is what the chat summary has always done.
    const properName = optBot.tradeSummary.showProperName;
    const named = (names: string[]): string[] => (properName ? names : names.map(n => t.replace.itemName(n)));

    const itemsName = {
        invalid: named(accepted.invalidItems),
        disabled: named(accepted.disabledItems),
        overstock: named(accepted.overstocked),
        understock: named(accepted.understocked),
        duped: [] as string[],
        dupedFailed: [] as string[],
        highValue: named(accepted.highValue)
    };

    const keyPrices = bot.pricelist.getKeyPrices;
    const value = t.valueDiff(offer);

    const dict = offer.data('dict') as ItemsDict;
    const mentionOwner = buildMention(optDW, dict, value.ourValue, {
        invalid: itemsName.invalid.length,
        highValue: itemsName.highValue.length,
        isMentionHV: accepted.isMention
    });

    const details = await getPartnerDetails(offer, bot);

    const botInfo = bot.handler.getBotInfo;
    const links = t.generateLinks(offer.partner.toString());
    const misc = optDW.tradeSummary.misc;

    const isShowOfferMessage = optBot.tradeSummary.showOfferMessage;
    const cTOfferMessage = optBot.tradeSummary.customText.offerMessage.discordWebhook || '💬 **Offer message:**';
    // The other customText.* entries have no home here: asked/offered and the
    // profit wording are drawn on the card or in the title, and keyRate /
    // pureStock / totalItems belong to buildStatBoxes in renderTradeCard.

    const message = t.replace.specialChar(offer.message);

    // ── Header ────────────────────────────────────────────────────────────────
    const net = t.isNetOverpayRelevant('summary-accepted', isOfferSent) ? t.getNetOverpay(offer, bot) : null;

    const meta: TradeCardMeta = {
        timeTakenToComplete,
        timeTakenToProcessOrConstruct,
        timeTakenToCounterOffer,
        isOfferSent,
        net
    };
    const cardOptions = optDW.tradeSummary.tradeCard;
    const card = cardOptions.enable
        ? await renderCard(
              offer,
              bot,
              // The spread carries the card options output of `enable`, which
              // TradeCardOptions does not itself carry.
              { ...cardOptions, partnerName: details.personaName, partnerAvatarUrl: details.avatarFull },
              meta
          )
        : null;
    const attachmentName = `trade-${offer.id}.png`;

    const isCountered = offer.data('processCounterTime') !== undefined;
    const source =
        isOfferSent === undefined ? '' : isOfferSent ? ' (chat)' : ` (offer${isCountered ? ' - countered' : ''})`;

    let title = `✅ Accepted${source}`;
    if (net && net.scrap !== 0) {
        const magnitude = Currencies.toCurrencies(Math.round(Math.abs(net.scrap)), net.keyRate).toString();
        title += net.scrap > 0 ? `  ·  📈 +${magnitude}` : `  ·  📉 -${magnitude}`;
    }

    const botLinks = misc.note
        ? misc.note
        : `[Backpack](https://backpack.tf/profiles/${botInfo.steamID.getSteamID64()})${
              bot.options.miscSettings.pricedbStore.enable ? ` · [Store](${bot.getPricedbStoreUrl()})` : ''
          }`;

    const keyRateMetal = bot.pricelist.getKeyPrice.metal;
    const profitData = collectItemProfits(offer, bot);

    const identity = `#${offer.id} • ${offer.partner.toString()} • v${process.env.BOT_VERSION}`;

    // ── Body ──────────────────────────────────────────────────────────────────
    // Components V2: one ordered array, text and image interleaved freely, every
    // Text Display fully markdown.
    //
    // The name is itself the Steam link, so the row is three destinations with no
    // repeats. Title at h3, not h2, which dominated a message whose subject is the
    // card below it; the partner line is bold body text to stay clear of it.
    const partnerDisplayName = escapeMarkdown(details.personaName);
    const partnerLine = misc.showQuickLinks
        ? `**[${partnerDisplayName}](${links.steam}) | [backpack.tf](${links.bptf}) | [rep.tf](${links.reptf})**`
        : `**[${partnerDisplayName}](${links.steam})**`;
    const headerBlock = [`### ${title}`, partnerLine].join('\n');

    // Three lines rather than one: identity plus both timestamp forms measured as
    // the widest line in the message, and the container stretched to match.
    const unixSeconds = Math.floor(Date.now() / 1000);
    const subtextBlock = `-# 🤖 ${botLinks}\n` + `-# ${identity}\n` + `-# <t:${unixSeconds}:f> · <t:${unixSeconds}:R>`;

    const flags = [
        { label: '🟨 invalid', count: itemsName.invalid.length },
        { label: '🟧 disabled', count: itemsName.disabled.length },
        { label: '🟦 overstocked', count: itemsName.overstock.length },
        // No high-value count: their attributes are named in full below.
        { label: '🟩 understocked', count: itemsName.understock.length }
    ];

    // The status block is the card's text twin: the same readings and prices the
    // card would draw, so the summary never loses them to a render failure.
    const statusText =
        card === null
            ? buildStatusBlock(collectStatReadings(bot, meta), collectPricedItems(offer, bot, keyRateMetal))
            : '';

    // Decide the verbosity on the *compact* form (fixed blocks only, so a big
    // trade cannot starve the item links), then rebuild verbose if there is
    // still room for roughly a side block's worth of links.
    const detailMessage = isShowOfferMessage ? message : '';
    const compact = buildDetailBlock(
        detailMessage,
        cTOfferMessage,
        flags,
        itemsName.highValue,
        profitData,
        keyRateMetal,
        { offer, bot, itemsName, verbose: false }
    );
    const compactFixed = headerBlock.length + compact.length + statusText.length + subtextBlock.length;
    const verbose = TOTAL_TEXT_BUDGET - BUDGET_SAFETY_MARGIN - compactFixed >= MIN_LINK_BUDGET;

    let detailBlock = verbose
        ? buildDetailBlock(detailMessage, cTOfferMessage, flags, itemsName.highValue, profitData, keyRateMetal, {
              offer,
              bot,
              itemsName,
              verbose: true
          })
        : compact;

    if (statusText.length > 0) {
        detailBlock += `\n${statusText}`;
    }

    const fixedTextLength = headerBlock.length + detailBlock.length + subtextBlock.length;
    const linkBudget = Math.max(0, TOTAL_TEXT_BUDGET - BUDGET_SAFETY_MARGIN - fixedTextLength);
    const sideBlocks = buildItemLinkBlocks(offer, bot, linkBudget);

    const children: Container['components'] = [{ type: 10, content: headerBlock }];
    const addDivider = (divider: boolean): void => {
        children.push({ type: 14, divider, spacing: 1 });
    };

    if (card || sideBlocks.length > 0) {
        addDivider(true);
    }

    if (card) {
        children.push({ type: 12, items: [{ media: { url: `attachment://${attachmentName}` } }] });
    }

    sideBlocks.forEach((block, i) => {
        if (i > 0) {
            addDivider(false);
        }
        children.push({ type: 10, content: block });
    });

    if (detailBlock.length > 0) {
        addDivider(true);
        children.push({ type: 10, content: detailBlock });
    }

    addDivider(true);
    children.push({ type: 10, content: subtextBlock });

    const topLevel: Webhook['components'] = [];
    if (mentionOwner) {
        topLevel.push({ type: 10, content: mentionOwner });
    }
    topLevel.push({ type: 17, accent_color: Number(optDW.embedColor), components: children });

    const acceptedTradeSummary: Webhook = {
        username: optDW.displayName || botInfo.name,
        avatar_url: optDW.avatarURL || botInfo.avatarURL,
        flags: COMPONENTS_V2_FLAG,
        components: topLevel,
        allowed_mentions: { parse: ['users', 'roles'] }
    };

    const attachment: WebhookAttachment | undefined = card ? { name: attachmentName, buffer: card } : undefined;
    const url = optDW.tradeSummary.url;

    url.forEach((link, i) => {
        sendWebhook(link, acceptedTradeSummary, 'trade-summary', i, attachment).catch(err => {
            log.warn(
                `❌ Failed to send trade-summary webhook (#${offer.id}) to Discord ${
                    url.length > 1 ? `(${i + 1})` : ''
                }: `,
                err
            );

            const itemListx = t.listItems(offer, bot, itemsName, true);

            void sendToAdmin(
                bot,
                offer,
                value,
                itemListx,
                keyPrices,
                isOfferSent,
                timeTakenToComplete,
                timeTakenToProcessOrConstruct,
                timeTakenToCounterOffer,
                isAcceptedWithEscrow
            );
        });
    });
}

type WebhookOptions = Bot['options']['discordWebhook'];

/**
 * The mention line above the container, or '' for no ping.
 *
 * Two separate triggers, in priority order: an accepted trade that needs
 * looking at (invalid or high-value items), which says why; and the owner's own
 * `mentionOwner` watchlist — a sku or a trade value they asked to hear about —
 * which is a bare ping.
 */
function buildMention(
    optDW: WebhookOptions,
    dict: ItemsDict,
    ourValueScrap: number,
    counts: { invalid: number; highValue: number; isMentionHV: boolean }
): string {
    const owners = optDW.ownerID;
    if (owners.length === 0) {
        return '';
    }

    const ping = owners.map(id => `<@!${id}>`).join(', ');
    const { invalid, highValue, isMentionHV } = counts;

    if (invalid > 0 || isMentionHV) {
        const what =
            invalid > 0 && isMentionHV
                ? `INVALID_ITEMS and High value ${pluralize('item', invalid + highValue)}`
                : invalid > 0
                ? `INVALID_ITEMS ${pluralize('item', invalid)}`
                : `High Value ${pluralize('item', highValue)}`;

        return `${ping} - Accepted ${what} trade here!`;
    }

    const watch = optDW.tradeSummary.mentionOwner;
    if (!watch.enable) {
        return '';
    }

    const traded = Object.keys(dict.our).concat(Object.keys(dict.their));
    const matchesSku = watch.itemSkus.some(wanted => traded.some(sku => sku.includes(wanted)));
    const matchesValue = watch.tradeValueInRef > 0 && ourValueScrap >= Currencies.toScrap(watch.tradeValueInRef);

    return matchesSku || matchesValue ? ping : '';
}

/** A Steam persona name can contain markdown metacharacters; escaped so one bad name cannot break the header's bold/link formatting. */
function escapeMarkdown(text: string): string {
    return text.replace(/([*_~`|>])/g, '\\$1');
}

interface LinkedEntry {
    sku: string;
    name: string;
    amount: number;
    value: number;
    stock: string;
}

/** Collects one side's tradeable entries, pure sorted after real items — the same order the card's tiles use. */
function collectLinkedEntries(
    dict: OurTheirItemsDict,
    bot: Bot,
    which: 'our' | 'their',
    valueOf: (sku: string) => number
): LinkedEntry[] {
    if (!dict) {
        return [];
    }

    const properName = bot.options.tradeSummary.showProperName;
    const showStock = bot.options.tradeSummary.showStockChanges;
    // `showPureInEmoji` renders pure as its emoji token on the card and the
    // item list alike — the same map the Steam-chat summary already uses.
    const showPureEmoji = bot.options.tradeSummary?.showPureInEmoji === true;
    const entries: LinkedEntry[] = [];
    const pure: LinkedEntry[] = [];

    for (const priceKey of Object.keys(dict)) {
        const amount = amountOf(dict[priceKey]);
        // Paint suffixes are a pricing concept; pricedb.io keys pages by the base sku.
        const sku = priceKey.replace(/;p\d+/, '');

        if (amount <= 0 || !t.testPriceKey(sku)) {
            continue;
        }

        try {
            const generated = bot.schema.getName(SKU.fromString(sku), properName);
            // `get` is only consulted for a pure sku (PURE_SKUS), which the map
            // always holds; undefined for anything else falls through to the name.
            const emoji = showPureEmoji ? t.pureEmoji.get(sku) : undefined;
            const entry: LinkedEntry = {
                sku,
                name: emoji ?? (properName ? generated : t.replace.itemName(generated)),
                amount,
                value: valueOf(priceKey),
                // Shared with the text summary so the two can never disagree
                // about which side of the trade the inventory has already seen.
                stock: showStock ? t.stockChangeText(bot, priceKey, which, 'summary-accepted', amount) : ''
            };

            // Pure is what the trade was *paid in*, so it sorts after what was
            // actually traded — the order the card's tiles use too.
            (PURE_SKUS.includes(sku) ? pure : entries).push(entry);
        } catch (err) {
            log.debug(`Could not name ${sku} for the trade summary links: `, err);
        }
    }

    entries.sort((a, b) => b.value - a.value);
    pure.sort((a, b) => PURE_SKUS.indexOf(a.sku) - PURE_SKUS.indexOf(b.sku));
    entries.push(...pure);
    return entries;
}

/** How much detail the item lines can afford. Tightened a field at a time when the budget bites. */
interface LinkDetail {
    capItems: number;
    stock: boolean;
    links: boolean;
    nameCap: number;
}

function formatLinkedEntry(e: LinkedEntry, detail: LinkDetail): string {
    const name = clamp(e.name, detail.nameCap);
    const label = detail.links ? `[${name}](https://pricedb.io/item/${e.sku})` : name;
    const amount = e.amount > 1 ? ` ×${e.amount}` : '';
    const stock = detail.stock && e.stock ? ` (${e.stock})` : '';
    return `${label}${amount}${stock}`;
}

/**
 * A container sizes to its widest line, unlike the embed's fixed ~520px, and the
 * card image scales with it. Wrapping at a fixed count keeps every line roughly
 * as wide regardless of trade size, so a big trade grows taller, not wider.
 */
const ITEMS_PER_LINE = 3;

function renderSideBody(entries: LinkedEntry[], detail: LinkDetail): string {
    const shown = entries.slice(0, detail.capItems);
    const rest = entries.length - shown.length;
    const parts = shown.map(e => formatLinkedEntry(e, detail));

    if (rest > 0) {
        parts.push(`+${rest} more`);
    }

    const lines: string[] = [];
    for (let i = 0; i < parts.length; i += ITEMS_PER_LINE) {
        lines.push(parts.slice(i, i + ITEMS_PER_LINE).join('  ·  '));
    }

    return lines.join('\n');
}

const SIDE_LABELS: Record<'their' | 'our', string> = {
    their: '📥 **They Sent**',
    our: '📤 **For Our**'
};

/**
 * One block per side that has anything to show. A one-way gift contributes no
 * block for the empty side, rather than a heading over an empty line.
 *
 * `budget` is what is left of the 4000-character ceiling once the fixed blocks
 * are built. A trade that does not fit degrades in stages rather than
 * truncating mid-link into a raw URL.
 */
export function buildItemLinkBlocks(
    offer: TradeOffer,
    bot: Bot,
    budget: number = TOTAL_TEXT_BUDGET - BUDGET_SAFETY_MARGIN
): string[] {
    const dict = offer.data('dict') as ItemsDict | undefined;
    if (!dict) {
        return [];
    }

    const value = offer.data('value') as ItemsValue | undefined;
    const valueOf = unitValueOf(offer, bot, value?.rate ?? bot.pricelist.getKeyPrice.metal);

    const theirEntries = collectLinkedEntries(dict.their, bot, 'their', valueOf);
    const ourEntries = collectLinkedEntries(dict.our, bot, 'our', valueOf);

    const detail: LinkDetail = { capItems: MAX_LINKED_ITEMS, stock: true, links: true, nameCap: Infinity };

    const build = (): string[] =>
        [
            [SIDE_LABELS.their, renderSideBody(theirEntries, detail)],
            [SIDE_LABELS.our, renderSideBody(ourEntries, detail)]
        ]
            .filter(([, body]) => body !== '')
            .map(([label, body]) => `${label}\n${body}`);

    let blocks = build();
    const fits = (): boolean => blocks.reduce((n, b) => n + b.length, 0) <= budget;

    // Cheapest loss first: "(3 → 2/5)" goes before a name is shortened, and both
    // go before the links themselves.
    for (const tighten of [
        () => (detail.stock = false),
        () => (detail.nameCap = TIGHT_NAME_CAP),
        () => (detail.links = false)
    ]) {
        if (fits()) {
            return blocks;
        }

        tighten();
        blocks = build();
    }

    while (!fits() && detail.capItems > 1) {
        detail.capItems--;
        blocks = build();
    }

    return blocks;
}

/** The shape sendTradeSummary builds for `t.listItems`: the flag lists, named. */
type ItemsName = {
    invalid: string[];
    disabled: string[];
    overstock: string[];
    understock: string[];
    duped: string[];
    dupedFailed: string[];
    highValue: string[];
};

/**
 * When the budget allows, the detail block names the flagged items in full via
 * the old `listItems` block instead of counting them and naming high values.
 * `verbose: false` (the default, and all existing callers) is today's behaviour.
 */
interface DetailExtra {
    verbose?: boolean;
    offer?: TradeOffer;
    bot?: Bot;
    itemsName?: ItemsName;
}

/**
 * Everything the card cannot carry: offer message, the stock-flag counts,
 * high-value attributes and per-item profit, in that order. Shown whether or not
 * the card rendered.
 *
 * With `extra.verbose` the flag count and the `highValueLines(...)` output are
 * replaced by a single wholesale `t.listItems(...)` block (its `@` field
 * splitter stripped — meaningless in a Text Display): the old embed's own
 * renderer, reusing its HIGH_VALUE_ITEMS section and its `showItemPrices` gate
 * rather than writing a second one.
 */
export function buildDetailBlock(
    message: string,
    offerMessageLabel: string,
    flags: { label: string; count: number }[],
    highValue: string[],
    profits: ProfitData,
    keyRateMetal: number,
    extra?: DetailExtra
): string {
    const { verbose = false, offer, bot, itemsName } = extra ?? {};
    const lines: string[] = [];

    if (message.length > 0) {
        lines.push(`${offerMessageLabel} "${clamp(message, MESSAGE_CAP)}"`);
    }

    if (verbose && offer && bot && itemsName) {
        // Prices already live on the rendered card (and, card-absent, in the
        // buildStatusBlock fallback below), so this verbatim listItems block
        // reuses only its flag and high-value naming — never a second set of
        // prices. Flip its own showItemPrices gate off instead of slicing the
        // string. The clone is a shallow options override; listItems only reads
        // tradeSummary options, schema, and pricelist (all preserved by ref).
        const tSum = bot.options.tradeSummary;
        const listBot = tSum
            ? ({ ...bot, options: { ...bot.options, tradeSummary: { ...tSum, showItemPrices: false } } } as Bot)
            : bot;

        const listed = t.listItems(offer, listBot, itemsName, false).replace(/@/g, '');
        if (listed !== '-') {
            lines.push(listed);
        }
    } else {
        const activeFlags = flags.filter(f => f.count > 0);
        if (activeFlags.length > 0) {
            lines.push(activeFlags.map(f => `${f.label} ${f.count}`).join('  ·  '));
        }

        lines.push(...highValueLines(highValue));
    }

    lines.push(...profitLines(profits, keyRateMetal));

    return lines.join('\n');
}

/**
 * The card-disabled fallback: one markdown line per stat reading, in the same
 * order the card draws them, plus the priced items when the card is absent.
 * Lives here (not in offerFacts) because it is presentation; the readings are
 * the shared facts both this and the card format, so the toggles cannot drift.
 *
 * `prices` come from `collectPricedItems` (already `showItemPrices`-gated), so
 * this is the single text-home of prices when there is no card to draw them.
 */
export function buildStatusBlock(readings: StatReading[], prices: PricedItem[]): string {
    const lines: string[] = [];

    for (const r of readings) {
        switch (r.kind) {
            case 'keyRate':
                lines.push(`${r.label} ${r.value}  ·  ${r.sub}`);
                break;
            case 'pureStock':
                lines.push(`${r.label} ${r.value}  ·  ${r.sub}`);
                break;
            case 'totalItems':
                lines.push(`${r.label} ${r.value}${r.sub ? ` ${r.sub}` : ''}`);
                break;
            case 'timeTaken':
                if (r.detailed) {
                    lines.push(r.label);
                    for (const [caption, figure, ms] of r.rows) {
                        lines.push(`- ${caption}: ${figure}${r.showMs ? ` (${ms} ms)` : ''}`);
                    }
                } else {
                    const [, figure, ms] = r.rows[0];
                    lines.push(`${r.label} ${figure}${r.showMs ? ` (${ms} ms)` : ''}`);
                }
                break;
        }
    }

    if (prices.length > 0) {
        lines.push('📜 **Item prices**');
        // The card's own row shaper decides how many fit and what the overflow
        // row says, so the two renderings cannot disagree on the cut. Its
        // overflow row carries an empty right half; that one goes out bare.
        for (const [left, right] of priceRows(prices)) {
            lines.push(right ? `- **${clamp(left, NAME_CAP)}** ${right}` : left);
        }
    }

    return lines.join('\n');
}

/**
 * Spells, strange parts, killstreakers, sheens and paint, one line per item.
 * Entries arrive formatted for the chat summary — name in `_…_`, one attachment
 * per line — so the underscores come off and the block folds flat. The card
 * badges these; here they get named.
 */
function highValueLines(items: string[]): string[] {
    if (items.length === 0) {
        return [];
    }

    const shown = items.slice(0, MAX_HIGH_VALUE_LINES).map(entry => {
        const flat = entry
            .replace(/_/g, '')
            .split('\n')
            .map(part => part.trim())
            .filter(part => part.length > 0)
            .join('  ');

        return `🔶 ${clamp(flat, HIGH_VALUE_LINE_CAP)}`;
    });

    const rest = items.length - shown.length;
    if (rest > 0) {
        shown.push(`🔶 +${rest} more high value ${rest === 1 ? 'item' : 'items'}`);
    }

    return shown;
}

function profitLines(data: ProfitData, keyRateMetal: number): string[] {
    const lines: string[] = [];

    if (data.profits.length > 0 && data.profits.length <= MAX_PROFIT_LINES) {
        // Few enough to name individually, which is the interesting case.
        for (const p of data.profits) {
            lines.push(
                `${profitIndicator(p.profitScrap)} ${clamp(p.name, NAME_CAP)} ${p.buy} → ${p.sell}  ·  ` +
                    `${Currencies.toCurrencies(p.profitScrap, keyRateMetal).toString()}  ·  ` +
                    `${formatDuration(p.heldForMs)}`
            );
        }
    } else if (data.profits.length > 0) {
        // Too many to list: report the total and the single biggest earner.
        const total = data.profits.reduce((sum, p) => sum + p.profitScrap, 0);
        const best = data.profits.reduce((a, b) => (b.profitScrap > a.profitScrap ? b : a));

        lines.push(
            `${profitIndicator(total)} ${Currencies.toCurrencies(total, keyRateMetal).toString()} across ` +
                `${data.profits.length} items  ·  best ${clamp(best.name, NAME_CAP)} ` +
                `${Currencies.toCurrencies(best.profitScrap, keyRateMetal).toString()}`
        );
    }

    if (data.missing.length > 0) {
        const named = data.missing.slice(0, 2).map(name => clamp(name, NAME_CAP));
        const rest = data.missing.length - named.length;

        lines.push(`⚠️ no cost data: ${named.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`);
    }

    return lines;
}

function clamp(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Lazily loaded: a missing or broken native canvas binding must not cost us the summary. */
async function renderCard(
    offer: TradeOffer,
    bot: Bot,
    options: TradeCardOptions,
    meta: TradeCardMeta
): Promise<Buffer | null> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { renderTradeCard } = require('./tradeCard') as typeof import('./tradeCard');
        return await renderTradeCard(offer, bot, options, meta);
    } catch (err) {
        log.warn(`Trade card unavailable for offer #${offer.id}, falling back to text: `, err);
        return null;
    }
}

/** One realised sale, before it is formatted for the detail block. */
interface ItemProfit {
    name: string;
    buy: string;
    sell: string;
    profitScrap: number;
    /** How long we held it before this sale. */
    heldForMs: number;
}

export interface ProfitData {
    profits: ItemProfit[];
    /** Items we sold with no purchase record, so no cost basis to profit against. */
    missing: string[];
}

function profitIndicator(scrap: number): string {
    return scrap > 0 ? '📈' : scrap < 0 ? '📉' : '➖';
}

function collectItemProfits(offer: TradeOffer, bot: Bot): ProfitData {
    const empty: ProfitData = { profits: [], missing: [] };

    const dict = offer.data('dict') as ItemsDict;
    if (!dict || !dict.our || Object.keys(dict.our).length === 0) {
        return empty;
    }

    // Written by calculateProfitData(); its presence is what marks this as a sale.
    const removedFifoEntries = offer.data('removedFifoEntries') as Record<string, FIFOEntry[]> | undefined;
    if (!removedFifoEntries || Object.keys(removedFifoEntries).length === 0) {
        return empty; // No FIFO data available - this was likely a buy
    }

    const itemProfits: ItemProfit[] = [];
    const itemsWithoutFifo: string[] = [];
    const prices = offer.data('prices') as Record<string, { sell?: { keys: number; metal: number } }> | undefined;

    const ourSKUs = Object.keys(dict.our);

    // Keys are payment rather than inventory, unless autokeys is banking them.
    const isAutokeysEnabled = bot.options.autokeys.enable;
    const skusInTrade = ourSKUs.filter(s => !METAL_SKUS.includes(s));
    const isKeyOnlyTrade = skusInTrade.length === 1 && skusInTrade[0] === KEY_SKU;

    ourSKUs.forEach(sku => {
        if (METAL_SKUS.includes(sku)) {
            return;
        }

        // Same logic as processAccepted.ts
        if (sku === KEY_SKU && (!isAutokeysEnabled || !isKeyOnlyTrade)) {
            return;
        }

        const fifoEntries = removedFifoEntries[sku];
        if (!fifoEntries || fifoEntries.length === 0) {
            return;
        }

        // Prefer the per-trade stored sell price (works for autopriced items too),
        // falling back to the live pricelist.
        const storedSell = prices?.[sku]?.sell;
        const pricelistEntry = bot.pricelist.getPrice({ priceKey: sku, onlyEnabled: false });
        const fallbackSell = storedSell ?? pricelistEntry?.sell;
        if (!fallbackSell) {
            return;
        }

        fifoEntries.forEach(fifoEntry => {
            const itemName = bot.schema.getName(SKU.fromString(sku), false);

            // No real purchase record: report it separately rather than inventing a cost.
            if (fifoEntry.tradeId === 'ESTIMATE') {
                itemsWithoutFifo.push(itemName);
                return;
            }

            // FIFO buy price, with distributed overpay/underpay folded in.
            const buyPrice = new Currencies({
                keys: fifoEntry.costKeys + fifoEntry.diffKeys,
                metal: fifoEntry.costMetal + fifoEntry.diffMetal
            });
            const sellPrice = new Currencies({ keys: fallbackSell.keys, metal: fallbackSell.metal });
            const keyRateMetal = bot.pricelist.getKeyPrice.metal;

            // One signed scrap total, split by toCurrencies afterwards: deriving both
            // parts from one value keeps their signs consistent, unlike a raw
            // `new Currencies({keys, metal})`, which can print "4 keys, -20.94 ref".
            const profitScrap = sellPrice.toValue(keyRateMetal) - buyPrice.toValue(keyRateMetal);

            itemProfits.push({
                name: itemName,
                buy: buyPrice.toString(),
                sell: sellPrice.toString(),
                profitScrap,
                // fifoEntry.timestamp is Unix seconds (see InventoryCostBasis.addItem).
                heldForMs: Date.now() - fifoEntry.timestamp * 1000
            });
        });
    });

    return { profits: itemProfits, missing: [...new Set(itemsWithoutFifo)] };
}

interface Accepted {
    invalidItems: string[];
    disabledItems: string[];
    overstocked: string[];
    understocked: string[];
    highValue: string[];
    isMention: boolean;
}
