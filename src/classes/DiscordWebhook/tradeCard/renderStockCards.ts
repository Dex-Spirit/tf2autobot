import { createCanvas } from '@napi-rs/canvas';

import { getItemIcon } from './itemImageCache';
import { registerTradeCardFonts } from './renderTradeCard';
import {
    CARD_BG,
    CARD_BORDER,
    drawCountPill,
    drawIcon,
    fitText,
    FONT_REGULAR,
    FONT_SEMIBOLD,
    PILL_TEXT,
    roundedRect,
    TILE_FILL
} from './cardCanvas';

export interface StockCardEntry {
    sku: string;
    name: string;
    amount: number;
}

const PAGE_SIZE = 20;
const WIDTH = 960;
const PADDING = 24;
const GAP = 16;
const COLUMNS = 4;
const TILE_WIDTH = (WIDTH - PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS;
const TILE_HEIGHT = 176;
const HEADER_HEIGHT = 70;
const HEIGHT = HEADER_HEIGHT + PADDING + TILE_HEIGHT * 5 + GAP * 4 + PADDING;

export function stockCardPages(entries: StockCardEntry[]): StockCardEntry[][] {
    return Array.from({ length: Math.ceil(entries.length / PAGE_SIZE) }, (_, page) =>
        entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    );
}

export async function renderStockCards(
    entries: StockCardEntry[],
    accountName: string,
    title: string
): Promise<Buffer[] | null> {
    try {
        registerTradeCardFonts();
        const pages = stockCardPages(entries);
        const images = await Promise.all(entries.map(entry => getItemIcon(entry.sku, accountName)));

        return pages.map((page, pageIndex) => {
            const canvas = createCanvas(WIDTH, HEIGHT);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = CARD_BG;
            roundedRect(ctx, 0, 0, WIDTH, HEIGHT, 24);
            ctx.fill();
            ctx.strokeStyle = CARD_BORDER;
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.font = `26px ${FONT_SEMIBOLD}`;
            ctx.fillStyle = PILL_TEXT;
            ctx.textAlign = 'left';
            ctx.fillText(title.toUpperCase(), PADDING, 43);
            ctx.font = `18px ${FONT_REGULAR}`;
            ctx.fillStyle = '#B8BEC9';
            ctx.textAlign = 'right';
            ctx.fillText(`PAGE ${pageIndex + 1}/${pages.length} · ${entries.length} ITEMS`, WIDTH - PADDING, 42);

            page.forEach((entry, index) => {
                const column = index % COLUMNS;
                const row = Math.floor(index / COLUMNS);
                const x = PADDING + column * (TILE_WIDTH + GAP);
                const y = HEADER_HEIGHT + PADDING + row * (TILE_HEIGHT + GAP);
                roundedRect(ctx, x, y, TILE_WIDTH, TILE_HEIGHT, 16);
                ctx.fillStyle = TILE_FILL;
                ctx.fill();
                ctx.strokeStyle = CARD_BORDER;
                ctx.lineWidth = 1.5;
                ctx.stroke();
                drawIcon(ctx, images[pageIndex * PAGE_SIZE + index], x + (TILE_WIDTH - 112) / 2, y + 16, 112);
                ctx.font = `18px ${FONT_REGULAR}`;
                ctx.fillStyle = PILL_TEXT;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText(
                    fitText(ctx, entry.name, FONT_REGULAR, 18, TILE_WIDTH - 24),
                    x + TILE_WIDTH / 2,
                    y + TILE_HEIGHT - 20
                );
                drawCountPill(ctx, x, y, TILE_WIDTH, TILE_HEIGHT, entry.amount);
            });
            return canvas.toBuffer('image/png');
        });
    } catch {
        return null;
    }
}
