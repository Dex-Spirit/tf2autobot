import { promises as fs } from 'fs';
import path from 'path';
import axios from 'axios';
import { createCanvas, loadImage, Image } from '@napi-rs/canvas';
import log from '../../../lib/logger';
import { getFilesPath } from '../../Options';

/** Edge length of a cached tile, in card pixels. Matches the tile box in renderTradeCard. */
export const TILE_SIZE = 226;

const IMAGE_ENDPOINT = 'https://sku.pricedb.io/api/sku';
const FETCH_TIMEOUT = 5000;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MEMORY_CACHE_LIMIT = 200;
const NEGATIVE_CACHE_MS = 6 * 60 * 60 * 1000;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decoded tiles, most-recently-used last. Map iteration order gives us the LRU for free. */
const memoryCache = new Map<string, Image>();

/** sku → epoch ms after which we are willing to try the network again. */
const negativeCache = new Map<string, number>();

/** sku → in-flight fetch, so a trade containing the same sku twice only hits the network once. */
const inFlight = new Map<string, Promise<Image | null>>();

/**
 * `sku.pricedb.io` answers `200 OK` no matter what, so the status code tells us
 * nothing. Observed failure modes:
 *   - `160;11;australium` → the pricedb.io homepage, as `text/html`
 *   - `notasku`           → a valid PNG of an entirely unrelated item
 *
 * Only the first is detectable. Serving a wrong-but-valid icon is a pricedb.io
 * data problem we cannot see from here.
 */
export function isValidPng(buffer: Buffer, contentType: string | undefined): boolean {
    if (!contentType || !contentType.toLowerCase().startsWith('image/')) {
        return false;
    }

    if (buffer.length === 0 || buffer.length > MAX_DOWNLOAD_BYTES) {
        return false;
    }

    return buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

/**
 * SKUs are drawn from `[0-9a-z;-]`, so mapping `;` (and anything else unexpected)
 * onto `_` cannot collide with a different sku. The tile size is part of the
 * name so that changing the card geometry re-fetches at the new size rather
 * than upscaling whatever the last layout happened to leave on disk.
 */
function cacheFileName(sku: string): string {
    return `${sku.replace(/[^a-zA-Z0-9_-]/g, '_')}@${TILE_SIZE}.png`;
}

function cacheDir(accountName: string): string {
    return path.join(getFilesPath(accountName), 'item-images');
}

function rememberInMemory(sku: string, image: Image): void {
    memoryCache.delete(sku);
    memoryCache.set(sku, image);

    while (memoryCache.size > MEMORY_CACHE_LIMIT) {
        memoryCache.delete(memoryCache.keys().next().value);
    }
}

/** Contain-fit the source onto a transparent TILE_SIZE square and re-encode. */
function toTile(source: Image): Buffer {
    const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const scale = Math.min(TILE_SIZE / source.width, TILE_SIZE / source.height);
    const width = source.width * scale;
    const height = source.height * scale;

    ctx.drawImage(source, (TILE_SIZE - width) / 2, (TILE_SIZE - height) / 2, width, height);

    return canvas.toBuffer('image/png');
}

async function readFromDisk(sku: string, accountName: string): Promise<Image | null> {
    try {
        const buffer = await fs.readFile(path.join(cacheDir(accountName), cacheFileName(sku)));
        return await loadImage(buffer);
    } catch (err) {
        return null;
    }
}

async function writeToDisk(sku: string, accountName: string, tile: Buffer): Promise<void> {
    const dir = cacheDir(accountName);

    try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, cacheFileName(sku)), tile);
    } catch (err) {
        // A cache we cannot persist is still a working cache in memory.
        log.debug(`Could not persist item image for ${sku}: `, err);
    }
}

async function download(sku: string): Promise<Image | null> {
    const response = await axios({
        method: 'GET',
        url: `${IMAGE_ENDPOINT}/${encodeURIComponent(sku)}/image`,
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT,
        maxRedirects: 5,
        maxContentLength: MAX_DOWNLOAD_BYTES,
        headers: { 'User-Agent': 'TF2AutobotCritTF@' + process.env.BOT_VERSION },
        validateStatus: status => status === 200
    });

    const buffer = Buffer.from(response.data as ArrayBuffer);

    if (!isValidPng(buffer, response.headers['content-type'] as string)) {
        log.debug(`Item image for ${sku} was not a PNG (content-type: ${response.headers['content-type'] as string})`);
        return null;
    }

    return loadImage(buffer);
}

/**
 * Resolve a sku to a TILE_SIZE square icon, or null when no usable art exists.
 *
 * Lookup order: memory → negative cache → disk → network. Successful downloads
 * are downscaled before being written, so the cache holds ~15 KB tiles rather
 * than the 47–130 KB originals the endpoint serves.
 */
export async function getItemIcon(sku: string, accountName: string): Promise<Image | null> {
    const cached = memoryCache.get(sku);
    if (cached) {
        rememberInMemory(sku, cached);
        return cached;
    }

    const blockedUntil = negativeCache.get(sku);
    if (blockedUntil !== undefined) {
        if (Date.now() < blockedUntil) {
            return null;
        }
        negativeCache.delete(sku);
    }

    const pending = inFlight.get(sku);
    if (pending !== undefined) {
        return pending;
    }

    const task = (async () => {
        const fromDisk = await readFromDisk(sku, accountName);
        if (fromDisk) {
            rememberInMemory(sku, fromDisk);
            return fromDisk;
        }

        try {
            const source = await download(sku);
            if (!source) {
                negativeCache.set(sku, Date.now() + NEGATIVE_CACHE_MS);
                return null;
            }

            const tile = toTile(source);
            await writeToDisk(sku, accountName, tile);

            const image = await loadImage(tile);
            rememberInMemory(sku, image);
            return image;
        } catch (err) {
            log.debug(`Could not fetch item image for ${sku}: `, err);
            negativeCache.set(sku, Date.now() + NEGATIVE_CACHE_MS);
            return null;
        }
    })().finally(() => inFlight.delete(sku));

    inFlight.set(sku, task);
    return task;
}
