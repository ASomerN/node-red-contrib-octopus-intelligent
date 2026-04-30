// __tests__/api-migration.test.js
'use strict';

// ── extractEvDevice ─────────────────────────────────────────────────────────
// Mirrors the inline helper in octopus-intelligent.js
function extractEvDevice(devices) {
    return (devices || []).find(d => d.deviceType === 'ELECTRIC_VEHICLES') || null;
}

describe('extractEvDevice', () => {
    const evDevice   = { id: 'ev-123', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: false } };
    const meterDevice = { id: 'em-456', deviceType: 'ELECTRICITY_METERS', status: { isSuspended: false } };

    test('returns EV device when present', () => {
        expect(extractEvDevice([meterDevice, evDevice])).toBe(evDevice);
    });

    test('returns null when no EV device in list', () => {
        expect(extractEvDevice([meterDevice])).toBeNull();
    });

    test('returns null for empty array', () => {
        expect(extractEvDevice([])).toBeNull();
    });

    test('returns null for null/undefined input', () => {
        expect(extractEvDevice(null)).toBeNull();
        expect(extractEvDevice(undefined)).toBeNull();
    });
});

// ── buildDevicePreferencesInput ──────────────────────────────────────────────
// Mirrors the inline helper in octopus-intelligent.js
const DAYS = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];

function buildDevicePreferencesInput(deviceId, limit, time) {
    return {
        deviceId,
        mode: 'CHARGE',
        unit: 'PERCENTAGE',
        schedules: DAYS.map(dayOfWeek => ({
            dayOfWeek,
            time: time + ':00',
            min: 0,
            max: limit
        }))
    };
}

describe('buildDevicePreferencesInput', () => {
    const result = buildDevicePreferencesInput('dev-abc', 85, '07:00');

    test('returns correct deviceId', () => {
        expect(result.deviceId).toBe('dev-abc');
    });

    test('mode is CHARGE and unit is PERCENTAGE', () => {
        expect(result.mode).toBe('CHARGE');
        expect(result.unit).toBe('PERCENTAGE');
    });

    test('produces exactly 7 schedules — one per day', () => {
        expect(result.schedules).toHaveLength(7);
    });

    test('schedule days cover all 7 days of the week', () => {
        const days = result.schedules.map(s => s.dayOfWeek);
        expect(days).toEqual(DAYS);
    });

    test('time is appended with :00 seconds', () => {
        result.schedules.forEach(s => expect(s.time).toBe('07:00:00'));
    });

    test('max equals the limit parameter', () => {
        result.schedules.forEach(s => expect(s.max).toBe(85));
    });

    test('min is always 0', () => {
        result.schedules.forEach(s => expect(s.min).toBe(0));
    });

    test('works with different limit and time values', () => {
        const r = buildDevicePreferencesInput('dev-xyz', 70, '08:30');
        expect(r.schedules[0].max).toBe(70);
        expect(r.schedules[0].time).toBe('08:30:00');
    });
});
