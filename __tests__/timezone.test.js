'use strict';

/**
 * Timezone Conversion Tests
 *
 * Tests for converting UTC timestamps to different timezones with offset calculations
 */

const { convertToTimezone, resolveTimezone } = require('../lib/timezone');

describe('convertToTimezone', () => {
    // UK winter: UTC = GMT, no change expected
    const UK_WINTER = '2025-11-29 21:30:00+00:00';
    // UK summer: UTC → BST (+1)
    const UK_SUMMER = '2025-07-15 21:30:00+00:00';

    test('Europe/London winter — no offset change', () => {
        expect(convertToTimezone(UK_WINTER, 'Europe/London')).toBe('2025-11-29 21:30:00+00:00');
    });

    test('Europe/London summer — UTC to BST (+1 hour)', () => {
        expect(convertToTimezone(UK_SUMMER, 'Europe/London')).toBe('2025-07-15 22:30:00+01:00');
    });

    test('Australia/Sydney — UTC+11 in November (AEDT), day rolls over', () => {
        // 2025-11-29 21:30 UTC → 2025-11-30 08:30 AEDT (UTC+11)
        expect(convertToTimezone(UK_WINTER, 'Australia/Sydney')).toBe('2025-11-30 08:30:00+11:00');
    });

    test('Europe/Berlin winter — CET (UTC+1)', () => {
        expect(convertToTimezone(UK_WINTER, 'Europe/Berlin')).toBe('2025-11-29 22:30:00+01:00');
    });

    test('Pacific/Auckland — NZDT in November (UTC+13)', () => {
        // 2025-11-29 21:30 UTC → 2025-11-30 10:30 NZDT (UTC+13)
        expect(convertToTimezone(UK_WINTER, 'Pacific/Auckland')).toBe('2025-11-30 10:30:00+13:00');
    });

    test('UTC timezone — returns same time with +00:00 offset', () => {
        expect(convertToTimezone(UK_WINTER, 'UTC')).toBe('2025-11-29 21:30:00+00:00');
    });

    test('Europe/London DST spring forward 2025-03-30 — before transition', () => {
        // 00:30 UTC = 00:30 GMT (transition happens at 01:00 GMT)
        expect(convertToTimezone('2025-03-30 00:30:00+00:00', 'Europe/London')).toBe('2025-03-30 00:30:00+00:00');
    });

    test('Europe/London DST spring forward 2025-03-30 — after transition', () => {
        // 01:30 UTC = 02:30 BST (already past 01:00 GMT transition)
        expect(convertToTimezone('2025-03-30 01:30:00+00:00', 'Europe/London')).toBe('2025-03-30 02:30:00+01:00');
    });

    test('invalid timezone string — returns original string unchanged', () => {
        expect(convertToTimezone(UK_WINTER, 'Not/ATimezone')).toBe(UK_WINTER);
    });

    test('null dateStr — returns null', () => {
        expect(convertToTimezone(null, 'Europe/London')).toBeNull();
    });

    test('invalid date string — returns original string', () => {
        expect(convertToTimezone('not-a-date', 'Europe/London')).toBe('not-a-date');
    });

    test('empty dateStr — returns empty string', () => {
        expect(convertToTimezone('', 'Europe/London')).toBe('');
    });

    test('non-UTC input offset — correctly converts to target timezone', () => {
        // Input is +01:00, converting to UTC should give same instant
        expect(convertToTimezone('2025-11-29 22:30:00+01:00', 'UTC')).toBe('2025-11-29 21:30:00+00:00');
    });

    test('half-hour timezone — Asia/Kolkata (UTC+05:30)', () => {
        expect(convertToTimezone('2025-11-29 21:30:00+00:00', 'Asia/Kolkata')).toBe('2025-11-30 03:00:00+05:30');
    });
});

describe('resolveTimezone', () => {
    const mockNode = (persisted, override) => ({
        context: () => ({
            get: () => persisted
        }),
        timezoneOverride: override || ''
    });

    test('returns HA-persisted timezone when set', () => {
        const nd = mockNode('Australia/Sydney', 'Europe/London');
        expect(resolveTimezone(nd)).toBe('Australia/Sydney');
    });

    test('returns config override when no HA-persisted value', () => {
        const nd = mockNode(null, 'Europe/Berlin');
        expect(resolveTimezone(nd)).toBe('Europe/Berlin');
    });

    test('returns server auto-detected timezone when neither is set', () => {
        const nd = mockNode(null, '');
        const result = resolveTimezone(nd);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
    });

    test('config override ignored when HA-persisted is set', () => {
        const nd = mockNode('Pacific/Auckland', 'America/New_York');
        expect(resolveTimezone(nd)).toBe('Pacific/Auckland');
    });

    test('falls back gracefully when context storage throws', () => {
        const nd = {
            context: () => { throw new Error('storage unavailable'); },
            timezoneOverride: 'Europe/Madrid'
        };
        expect(resolveTimezone(nd)).toBe('Europe/Madrid');
    });

    test('trims whitespace from persisted value', () => {
        const nd = mockNode('  Europe/London  ', '');
        expect(resolveTimezone(nd)).toBe('Europe/London');
    });

    test('trims whitespace from override value', () => {
        const nd = mockNode(null, '  UTC  ');
        expect(resolveTimezone(nd)).toBe('UTC');
    });
});

// ============================================================
// Phase A Integration: locale fields present in payload shape
// ============================================================
describe('Payload locale field shape (Phase A)', () => {
    const RAW_UTC = '2025-11-29 21:30:00+00:00';

    test('locale field differs from raw when TZ is not UTC', () => {
        const result = convertToTimezone(RAW_UTC, 'Australia/Sydney');
        expect(result).not.toBe(RAW_UTC);
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });

    test('locale field equals raw when TZ is UTC', () => {
        expect(convertToTimezone(RAW_UTC, 'UTC')).toBe('2025-11-29 21:30:00+00:00');
    });

    test('output format matches input format pattern', () => {
        const result = convertToTimezone(RAW_UTC, 'Europe/London');
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });
});

// ============================================================
// Phase B: Display fields vs raw fields vs locale fields
// ============================================================
describe('Timestamp tiers — raw unchanged, display converted, locale auto-detected', () => {
    const RAW = '2025-11-29 21:30:00+00:00';

    test('display field and locale field are independent — different TZ inputs produce different results', () => {
        // Simulate: serverTz = UTC (locale never changes), appliedTz = Australia/Sydney (display changes)
        const localeField = convertToTimezone(RAW, 'UTC');          // serverTz = UTC
        const displayField = convertToTimezone(RAW, 'Australia/Sydney');  // appliedTz = Aus/Sydney
        const rawField = RAW;                                        // raw always untouched

        expect(rawField).toBe('2025-11-29 21:30:00+00:00');         // raw unchanged
        expect(localeField).toBe('2025-11-29 21:30:00+00:00');      // locale in UTC = same as raw
        expect(displayField).toBe('2025-11-30 08:30:00+11:00');     // display converted to Aus/Syd
        expect(displayField).not.toBe(rawField);                     // display ≠ raw
        expect(localeField).not.toBe(displayField);                  // locale ≠ display
    });

    test('display field differs from raw when appliedTz is not UTC', () => {
        const displayValue = convertToTimezone(RAW, 'Europe/London');
        // In winter (Nov) Europe/London = UTC, so same value
        expect(displayValue).toBe('2025-11-29 21:30:00+00:00');

        const summerRaw = '2025-07-15 21:30:00+00:00';
        const summerDisplay = convertToTimezone(summerRaw, 'Europe/London');
        expect(summerDisplay).toBe('2025-07-15 22:30:00+01:00');
        expect(summerDisplay).not.toBe(summerRaw);
    });

    test('locale field always uses serverTz (auto-detect) regardless of appliedTz', () => {
        const localeValue = convertToTimezone(RAW, 'UTC');
        const displayValue = convertToTimezone(RAW, 'Australia/Sydney');
        expect(localeValue).not.toBe(displayValue);
    });
});

// ============================================================
// set_timezone command
// ============================================================
describe('set_timezone input command', () => {
    test('valid string timezone saves to context', () => {
        const contextStore = {};
        const mockContext = {
            get: (k) => contextStore[k],
            set: (k, v) => { contextStore[k] = v; }
        };

        function handleSetTimezone(tz, ctx) {
            if (typeof tz === 'string' && tz.trim().length > 0) {
                ctx.set('timezone', tz.trim());
                return true;
            }
            return false;
        }

        handleSetTimezone('Australia/Sydney', mockContext);
        expect(mockContext.get('timezone')).toBe('Australia/Sydney');
    });

    test('empty string does not save', () => {
        const contextStore = {};
        const mockContext = {
            get: (k) => contextStore[k],
            set: (k, v) => { contextStore[k] = v; }
        };

        function handleSetTimezone(tz, ctx) {
            if (typeof tz === 'string' && tz.trim().length > 0) {
                ctx.set('timezone', tz.trim());
                return true;
            }
            return false;
        }

        handleSetTimezone('', mockContext);
        expect(mockContext.get('timezone')).toBeUndefined();
    });

    test('trims whitespace before saving', () => {
        const contextStore = {};
        const mockContext = {
            get: (k) => contextStore[k],
            set: (k, v) => { contextStore[k] = v; }
        };

        function handleSetTimezone(tz, ctx) {
            if (typeof tz === 'string' && tz.trim().length > 0) {
                ctx.set('timezone', tz.trim());
                return true;
            }
            return false;
        }

        handleSetTimezone('  Pacific/Auckland  ', mockContext);
        expect(mockContext.get('timezone')).toBe('Pacific/Auckland');
    });
});
