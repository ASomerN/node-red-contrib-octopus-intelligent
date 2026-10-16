'use strict';
const { isDue, alignedStart, wrapWithInFlightGuard } = require('../lib/scheduler');

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

describe('wrapWithInFlightGuard', () => {
    it('runs the wrapped function when nothing is in flight', async () => {
        const fn = jest.fn().mockResolvedValue('ok');
        const guarded = wrapWithInFlightGuard(fn);
        await guarded();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('skips re-entry while a prior call is still pending', async () => {
        let resolveFirst;
        const fn = jest.fn().mockImplementation(() => new Promise((r) => { resolveFirst = r; }));
        const guarded = wrapWithInFlightGuard(fn);
        const p1 = guarded();
        const p2 = guarded();
        expect(fn).toHaveBeenCalledTimes(1);
        await p2;
        resolveFirst();
        await p1;
        guarded();
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight flag even if fn throws', async () => {
        const fn = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok');
        const guarded = wrapWithInFlightGuard(fn);
        await expect(guarded()).rejects.toThrow('boom');
        await guarded();
        expect(fn).toHaveBeenCalledTimes(2);
    });
});

// Sweep 2026-10-08 #10: a backward wall-clock jump must not stall polling until the clock
// catches up with lastPolled.
describe('isDue after the clock steps back (1.6.2)', () => {
    afterEach(() => { jest.useRealTimers(); });

    test('lastPolled in the future counts as due', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-30T12:00:00Z'));
        const cat = { enabled: true, intervalMs: 60 * 60 * 1000, lastPolled: Date.parse('2026-09-30T13:30:00Z') };
        expect(isDue(cat)).toBe(true);
    });

    test('lastPolled a moment ago in the same slot is still not due', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-30T12:10:00Z'));
        const cat = { enabled: true, intervalMs: 60 * 60 * 1000, lastPolled: Date.parse('2026-09-30T12:09:59Z') };
        expect(isDue(cat)).toBe(false);
    });

    test('a disabled category stays not due', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-30T12:00:00Z'));
        const cat = { enabled: false, intervalMs: 60000, lastPolled: Date.parse('2026-09-30T13:00:00Z') };
        expect(isDue(cat)).toBe(false);
    });
});

// Review 5 R5: an NTP correction of a second or two used to make every category polled in
// the last seconds due at once. Only a step of 60 s or more re-polls.
describe('isDue after a small or a large clock step back (1.6.2)', () => {
    afterEach(() => { jest.useRealTimers(); });

    test('a 2 s step back is not due and moves lastPolled back to now', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-30T12:00:00Z'));
        const cat = { enabled: true, intervalMs: 60 * 60 * 1000, lastPolled: Date.parse('2026-09-30T12:00:02Z') };
        expect(isDue(cat)).toBe(false);
        expect(cat.lastPolled).toBe(Date.parse('2026-09-30T12:00:00Z'));
    });

    test('a step of 60 s or more is due', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-30T12:00:00Z'));
        const cat = { enabled: true, intervalMs: 60 * 60 * 1000, lastPolled: Date.parse('2026-09-30T12:01:00Z') };
        expect(isDue(cat)).toBe(true);
    });

    test('through runTick: 2 s back polls nothing, 2 h back polls everything', async () => {
        const { runTick } = require('../lib/poll-tick');
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-30T12:10:00Z'));
        const make = (id, intervalMs) => ({ id, enabled: true, intervalMs, lastPolled: 0, poll: jest.fn(async () => ({})) });
        const cats = [make('intelligent', 5 * 60000), make('account', 3600000), make('update_check', 86400000)];
        const tick = () => runTick({ categories: cats, state: {}, getToken: async () => 't' });
        await tick();
        cats.forEach((c) => expect(c.poll).toHaveBeenCalledTimes(1));

        jest.setSystemTime(new Date('2026-09-30T12:09:58Z'));     // NTP: 2 s back
        expect((await tick()).emitted).toBe(false);
        cats.forEach((c) => expect(c.poll).toHaveBeenCalledTimes(1));

        jest.setSystemTime(new Date('2026-09-30T10:09:58Z'));     // 2 h back
        await tick();
        cats.forEach((c) => expect(c.poll).toHaveBeenCalledTimes(2));
    });
});
