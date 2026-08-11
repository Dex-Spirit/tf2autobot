import { createCanvas, Image } from '@napi-rs/canvas';
import Currencies from '@tf2autobot/tf2-currencies';

import { CurrentPure } from '../../../lib/tools/pure';
import { getItemIcon } from './itemImageCache';

const WIDTH = 960;
const HEIGHT = 300;
const PADDING = 28;
const GAP = 16;
const TILE_WIDTH = (WIDTH - PADDING * 2 - GAP * 3) / 4;
const TILE_HEIGHT = 190;
const TILE_TOP = 80;

const currencies = [
    { sku: '5021;6', label: 'Keys', getValue: (stock: CurrentPure) => stock.key },
    { sku: '5002;6', label: 'Refined', getValue: (stock: CurrentPure) => stock.ref },
    { sku: '5001;6', label: 'Reclaimed', getValue: (stock: CurrentPure) => stock.rec },
    { sku: '5000;6', label: 'Scrap', getValue: (stock: CurrentPure) => stock.scrap }
];

function roundedRect(
    ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
    x: number,
    y: number,
    w: number,
    h: number
) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 16);
    ctx.closePath();
}

function drawIcon(
    ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
    icon: Image | null,
    x: number,
    y: number
): void {
    if (icon === null) {
        return;
    }

    const size = 72;
    const scale = Math.min(size / icon.width, size / icon.height);
    const width = icon.width * scale;
    const height = icon.height * scale;
    ctx.drawImage(icon, x + (size - width) / 2, y + (size - height) / 2, width, height);
}

/** Render a compact, self-contained pure-currency card for a Discord attachment. */
export default async function renderPureStockCard(stock: CurrentPure, accountName: string): Promise<Buffer | null> {
    try {
        const icons = await Promise.all(currencies.map(currency => getItemIcon(currency.sku, accountName)));
        const canvas = createCanvas(WIDTH, HEIGHT);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#15171c';
        roundedRect(ctx, 0, 0, WIDTH, HEIGHT);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = '700 30px sans-serif';
        ctx.fillText('Pure Stock', PADDING, 43);
        ctx.fillStyle = '#b8bec9';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${Currencies.toRefined(stock.refTotalInScrap).toFixed(2)} ref in metal`, WIDTH - PADDING, 43);
        ctx.textAlign = 'left';

        currencies.forEach((currency, index) => {
            const x = PADDING + index * (TILE_WIDTH + GAP);
            roundedRect(ctx, x, TILE_TOP, TILE_WIDTH, TILE_HEIGHT);
            ctx.fillStyle = '#23262e';
            ctx.fill();
            ctx.strokeStyle = '#3b404c';
            ctx.lineWidth = 2;
            ctx.stroke();

            drawIcon(ctx, icons[index], x + 18, TILE_TOP + 22);
            ctx.fillStyle = '#dfe4ed';
            ctx.font = '600 21px sans-serif';
            ctx.fillText(currency.label, x + 100, TILE_TOP + 62);
            ctx.fillStyle = '#ffffff';
            ctx.font = '700 42px sans-serif';
            ctx.fillText(String(currency.getValue(stock)), x + 100, TILE_TOP + 118);
        });

        return canvas.toBuffer('image/png');
    } catch {
        return null;
    }
}
