import axios from 'axios';
import { createCanvas } from '@napi-rs/canvas';

import { CARD_BG, CARD_BORDER, FONT_REGULAR, FONT_SEMIBOLD, PILL_TEXT, roundedRect } from './cardCanvas';
import { registerTradeCardFonts } from './renderTradeCard';

interface HistoryPoint {
    time: number;
    buy: { keys: number; metal: number };
    sell: { keys: number; metal: number };
}

const WIDTH = 960;
const HEIGHT = 360;
const PAD = 56;
const BUY = '#72B7FF';
const SELL = '#8FE388';

/** Draw the last 90 days of PriceDB buy/sell history in current-rate ref equivalent. */
export default async function renderSkuChart(sku: string, keyRate: number): Promise<Buffer | null> {
    try {
        const start = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
        const response = await axios.get<HistoryPoint[]>(
            `https://pricedb.io/api/item-history/${encodeURIComponent(sku)}`,
            {
                params: { start },
                timeout: 5000
            }
        );
        const history = response.data.filter(point => Number.isFinite(point.time));
        if (history.length === 0) return null;

        registerTradeCardFonts();
        const values = history.flatMap(point => [
            point.buy.keys * keyRate + point.buy.metal,
            point.sell.keys * keyRate + point.sell.metal
        ]);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min || 1;
        const first = history[0].time;
        const last = history[history.length - 1].time;
        const span = last - first || 1;
        const canvas = createCanvas(WIDTH, HEIGHT);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = CARD_BG;
        roundedRect(ctx, 0, 0, WIDTH, HEIGHT, 24);
        ctx.fill();
        ctx.strokeStyle = CARD_BORDER;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.font = `24px ${FONT_SEMIBOLD}`;
        ctx.fillStyle = PILL_TEXT;
        ctx.fillText('PRICE HISTORY · 90 DAYS', PAD, 42);
        ctx.font = `16px ${FONT_REGULAR}`;
        ctx.fillStyle = '#B8BEC9';
        ctx.textAlign = 'right';
        ctx.fillText('Current-rate ref equivalent', WIDTH - PAD, 42);

        for (let i = 0; i <= 4; i++) {
            const y = 70 + ((HEIGHT - PAD - 70) * i) / 4;
            const value = max - (range * i) / 4;
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(PAD, y);
            ctx.lineTo(WIDTH - PAD, y);
            ctx.stroke();
            ctx.fillStyle = '#B8BEC9';
            ctx.textAlign = 'left';
            ctx.fillText(`${value.toFixed(2)} ref`, 8, y + 5);
        }

        const drawLine = (color: string, value: (point: HistoryPoint) => number): void => {
            ctx.strokeStyle = color;
            ctx.lineWidth = 3;
            ctx.beginPath();
            history.forEach((point, index) => {
                const x = PAD + ((point.time - first) / span) * (WIDTH - PAD * 2);
                const y = 70 + ((max - value(point)) / range) * (HEIGHT - PAD - 70);
                if (index === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            });
            ctx.stroke();
        };
        drawLine(BUY, point => point.buy.keys * keyRate + point.buy.metal);
        drawLine(SELL, point => point.sell.keys * keyRate + point.sell.metal);
        ctx.font = `16px ${FONT_SEMIBOLD}`;
        ctx.fillStyle = BUY;
        ctx.textAlign = 'left';
        ctx.fillText('● Buy', PAD, HEIGHT - 18);
        ctx.fillStyle = SELL;
        ctx.fillText('● Sell', PAD + 75, HEIGHT - 18);
        return canvas.toBuffer('image/png');
    } catch {
        return null;
    }
}
