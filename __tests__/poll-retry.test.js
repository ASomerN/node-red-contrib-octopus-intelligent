// __tests__/poll-retry.test.js
'use strict';
/**
 * 1.6.2 quick-retry helpers (lib/poll-retry.js): retry steps, the codes that are retried,
 * the dispatch-query rate window (max 3 in any 60 s, Octopus allows 5) and the recovery text.
 */
const {
    retryDelay, isRetryable, nextSlotStart, createRateWindow, formatDuration, RETRY_CODES,
} = require('../lib/poll-retry');

describe('retryDelay', () => {
    test('30 s, 1 min, 2 min, then every 2 min', () => {
        expect([1, 2, 3, 4, 5, 10].map(retryDelay)).toEqual([30000, 60000, 120000, 120000, 120000, 120000]);
    });
});

describe('isRetryable', () => {
    test('only KT-CT-4340 and KT-CT-4339 are retried', () => {
        expect(RETRY_CODES).toEqual(['KT-CT-4340', 'KT-CT-4339']);
        expect(isRetryable(Object.assign(new Error('x'), { code: 'KT-CT-4340' }))).toBe(true);
        expect(isRetryable(Object.assign(new Error('x'), { code: 'KT-CT-4339' }))).toBe(true);
        expect(isRetryable(Object.assign(new Error('x'), { code: 'KT-CT-4360' }))).toBe(false);
        expect(isRetryable(new Error('Request timed out'))).toBe(false);
        expect(isRetryable(null)).toBe(false);
    });
});

describe('nextSlotStart', () => {
    test('the next interval boundary after now, as the scheduler counts them', () => {
        const t = Date.parse('2026-09-30T01:05:00.100Z');
        expect(nextSlotStart(t, 5 * 60000)).toBe(Date.parse('2026-09-30T01:10:00Z'));
        expect(nextSlotStart(Date.parse('2026-09-30T01:10:00Z'), 5 * 60000)).toBe(Date.parse('2026-09-30T01:15:00Z'));
    });
});

describe('createRateWindow', () => {
    test('allows up to 3 queries in 60 s and then waits until the oldest is more than 60 s old', () => {
        const w = createRateWindow({ max: 3, windowMs: 60000 });
        expect(w.nextAllowedAt(1000)).toBe(1000);
        w.record(1000);
        w.record(11000);
        expect(w.nextAllowedAt(20000)).toBe(20000);
        w.record(30000);
        expect(w.nextAllowedAt(40000)).toBe(61001);
        expect(w.nextAllowedAt(61001)).toBe(61001);
        // exactly 60 s later still counts as inside the window
        expect(w.nextAllowedAt(61000)).toBe(61001);
    });

    test('never lets a 4th query into any closed 60 s window', () => {
        const w = createRateWindow({ max: 3, windowMs: 60000 });
        const times = [];
        for (let t = 0; t < 600000; t += 1000) {
            if (w.nextAllowedAt(t) <= t) { w.record(t); times.push(t); }
        }
        for (const t of times) {
            expect(times.filter((u) => u >= t && u <= t + 60000).length).toBeLessThanOrEqual(3);
        }
        expect(times.length).toBeGreaterThan(20);
    });
});

describe('formatDuration', () => {
    test('readable minutes and seconds', () => {
        expect(formatDuration(30000)).toBe('30s');
        expect(formatDuration(270000)).toBe('4m 30s');
        expect(formatDuration(210100)).toBe('3m 30s');
        expect(formatDuration(3725000)).toBe('1h 2m 5s');
        expect(formatDuration(0)).toBe('0s');
    });
});

// Sweep 2026-10-08 #10: after the wall clock steps back, queries recorded "in the future"
// must not count as recent, or retries and deferred polls wait for the length of the jump.
describe('createRateWindow after the clock steps back (1.6.2)', () => {
    test('queries dated after now do not count', () => {
        const w = createRateWindow({ max: 3, windowMs: 60000 });
        const later = Date.parse('2026-09-30T13:00:00Z');
        w.record(later);
        w.record(later + 1000);
        w.record(later + 2000);
        const now = later - 3600000; // the clock went back an hour
        expect(w.nextAllowedAt(now)).toBe(now);
    });

    test('record drops future entries, so the window works normally from the new time', () => {
        const w = createRateWindow({ max: 3, windowMs: 60000 });
        const later = 10000000;
        w.record(later);
        w.record(later + 1000);
        w.record(later + 2000);
        const now = later - 3600000;
        w.record(now);
        w.record(now + 1000);
        expect(w.nextAllowedAt(now + 2000)).toBe(now + 2000);
        w.record(now + 2000);
        expect(w.nextAllowedAt(now + 3000)).toBe(now + 60001);
        // Once the clock passes the old future times again they are gone, not counted twice.
        expect(w.nextAllowedAt(later + 3000)).toBe(later + 3000);
    });
});

// Review 5 R5: a small step back (NTP) must not empty the window.
describe('createRateWindow after a small clock step back (1.6.2)', () => {
    test('queries a few seconds "in the future" still count, as made now', () => {
        const w = createRateWindow({ max: 3, windowMs: 60000 });
        const later = Date.parse('2026-09-30T13:00:00Z');
        w.record(later);
        w.record(later + 1000);
        w.record(later + 2000);
        const now = later - 2000; // the clock went back 2 s
        expect(w.nextAllowedAt(now)).toBe(now + 60001);
    });

    test('a step of 60 s or more drops them', () => {
        const w = createRateWindow({ max: 3, windowMs: 60000 });
        const later = Date.parse('2026-09-30T13:00:00Z');
        w.record(later);
        w.record(later + 1000);
        w.record(later + 2000);
        expect(w.nextAllowedAt(later - 60000)).toBe(later - 60000);
    });
});
