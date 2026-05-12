'use strict';
const { isDue, alignedStart } = require('../lib/scheduler');

describe('isDue', () => {
    test('returns false when category is disabled', () => {
        const cat = { enabled: false, intervalMs: 5000, lastPolled: 0 };
        expect(isDue(cat)).toBe(false);
    });

    test('returns true when lastPolled is 0 (never polled)', () => {
        const cat = { enabled: true, intervalMs: 5 * 60 * 1000, lastPolled: 0 };
        expect(isDue(cat)).toBe(true);
    });

    test('returns false when polled within current slot', () => {
        const intervalMs = 5 * 60 * 1000;
        const now = Date.now();
        // lastPolled at start of current slot
        const currentSlot = Math.floor(now / intervalMs);
        const lastPolled = currentSlot * intervalMs;
        const cat = { enabled: true, intervalMs, lastPolled };
        expect(isDue(cat)).toBe(false);
    });

    test('returns true when polled in previous slot', () => {
        const intervalMs = 5 * 60 * 1000;
        const now = Date.now();
        const previousSlot = Math.floor(now / intervalMs) - 1;
        const lastPolled = previousSlot * intervalMs;
        const cat = { enabled: true, intervalMs, lastPolled };
        expect(isDue(cat)).toBe(true);
    });

    test('1-minute interval: due after 60 seconds have crossed slot boundary', () => {
        const intervalMs = 60 * 1000;
        // Pin to start of a known slot
        const slotStart = Math.floor(Date.now() / intervalMs) * intervalMs;
        const lastPolledInPreviousSlot = slotStart - 1;
        const cat = { enabled: true, intervalMs, lastPolled: lastPolledInPreviousSlot };
        expect(isDue(cat)).toBe(true);
    });
});

describe('alignedStart', () => {
    test('returns ms until next whole second boundary', () => {
        const now = 1000 * 5 + 300; // 5.3 seconds into epoch
        const delay = alignedStart(now);
        expect(delay).toBe(700); // 700ms until next whole second
    });

    test('returns 1000 when exactly on boundary', () => {
        const now = 5000; // exactly on second boundary
        const delay = alignedStart(now);
        expect(delay).toBe(1000);
    });
});
