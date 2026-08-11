import { createCanvas, Image, SKRSContext2D } from '@napi-rs/canvas';
import Currencies from '@tf2autobot/tf2-currencies';

import { CurrentPure } from '../../../lib/tools/pure';
import { getItemIcon } from './itemImageCache';
import { registerTradeCardFonts } from './renderTradeCard';

const WIDTH = 960;
const HEIGHT = 300;
const PADDING = 24;
const GAP = 20;
const TILE_WIDTH = (WIDTH - PADDING * 2 - GAP * 3) / 4;
const TILE_HEIGHT = 188;
const TILE_TOP = 24;
const TILE_RADIUS = 16;
const TOTAL_TOP = TILE_TOP + TILE_HEIGHT + 20;
const TOTAL_HEIGHT = 44;

const CARD_BG = '#2F3136';
const CARD_BORDER = 'rgba(255, 255, 255, 0.09)';
const TILE_FILL = 'rgba(255, 255, 255, 0.06)';
const PILL_FILL = 'rgba(0, 0, 0, 0.72)';
const PILL_TEXT = '#FFFFFF';
const TILE_BORDER = '#FFD700';
const FONT_SEMIBOLD = 'TradeCardSansSemi';
const FONT_REGULAR = 'TradeCardSans';

const currencies = [
    { sku: '5021;6', label: 'Keys', getValue: (stock: CurrentPure) => stock.key },
    { sku: '5002;6', label: 'Refined', getValue: (stock: CurrentPure) => stock.ref },
    { sku: '5001;6', label: 'Reclaimed', getValue: (stock: CurrentPure) => stock.rec },
    { sku: '5000;6', label: 'Scrap', getValue: (stock: CurrentPure) => stock.scrap }
];

function roundedRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, radius: number): void {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
}

function drawIcon(ctx: SKRSContext2D, icon: Image | null, x: number, y: number, size: number): void {
    if (icon === null) {
        return;
    }

    const scale = Math.min(size / icon.width, size / icon.height);
    const width = icon.width * scale;
    const height = icon.height * scale;
    ctx.drawImage(icon, x + (size - width) / 2, y + (size - height) / 2, width, height);
}

function drawCountPill(ctx: SKRSContext2D, x: number, y: number, amount: number): void {
    const label = `x${amount}`;
    ctx.font = `22px ${FONT_SEMIBOLD}`;
    const width = ctx.measureText(label).width + 20;
    const height = 34;
    const pillX = x + TILE_WIDTH - width - 12;
    const pillY = y + TILE_HEIGHT - height - 12;

    ctx.fillStyle = PILL_FILL;
    roundedRect(ctx, pillX, pillY, width, height, height / 2);
    ctx.fill();
    ctx.fillStyle = PILL_TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, pillX + width / 2, pillY + height / 2 + 1);
}

function drawTotal(ctx: SKRSContext2D, stock: CurrentPure): void {
    roundedRect(ctx, PADDING, TOTAL_TOP, WIDTH - PADDING * 2, TOTAL_HEIGHT, TILE_RADIUS);
    ctx.fillStyle = TILE_FILL;
    ctx.fill();
    ctx.strokeStyle = CARD_BORDER;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = `18px ${FONT_REGULAR}`;
    ctx.fillStyle = '#B8BEC9';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('TOTAL', PADDING + 18, TOTAL_TOP + TOTAL_HEIGHT / 2 + 1);

    ctx.font = `24px ${FONT_SEMIBOLD}`;
    ctx.fillStyle = PILL_TEXT;
    ctx.textAlign = 'right';
    ctx.fillText(
        `${stock.key} ${stock.key === 1 ? 'key' : 'keys'} · ${Currencies.toRefined(stock.refTotalInScrap).toFixed(
            2
        )} ref`,
        WIDTH - PADDING - 18,
        TOTAL_TOP + TOTAL_HEIGHT / 2 + 1
    );
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
}

/** Render a compact, self-contained pure-currency card for a Discord attachment. */
export default async function renderPureStockCard(stock: CurrentPure, accountName: string): Promise<Buffer | null> {
    try {
        registerTradeCardFonts();
        const icons = await Promise.all(currencies.map(currency => getItemIcon(currency.sku, accountName)));
        const canvas = createCanvas(WIDTH, HEIGHT);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = CARD_BG;
        roundedRect(ctx, 0, 0, WIDTH, HEIGHT, 24);
        ctx.fill();
        ctx.strokeStyle = CARD_BORDER;
        ctx.lineWidth = 2;
        ctx.stroke();

        currencies.forEach((currency, index) => {
            const x = PADDING + index * (TILE_WIDTH + GAP);
            roundedRect(ctx, x, TILE_TOP, TILE_WIDTH, TILE_HEIGHT, TILE_RADIUS);
            ctx.fillStyle = TILE_FILL;
            ctx.fill();
            ctx.strokeStyle = TILE_BORDER;
            ctx.lineWidth = 2;
            ctx.stroke();

            drawIcon(ctx, icons[index], x + (TILE_WIDTH - 120) / 2, TILE_TOP + 24, 120);
            drawCountPill(ctx, x, TILE_TOP, currency.getValue(stock));
        });
        drawTotal(ctx, stock);

        return canvas.toBuffer('image/png');
    } catch {
        return null;
    }
}
