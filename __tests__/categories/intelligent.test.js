// __tests__/categories/intelligent.test.js
'use strict';
const intelligent = require('../../lib/categories/intelligent');

// Mock shape derived from SmartFlexDeviceInterface + SmartFlexDispatch schema.
// IMPORTANT: validate field values against a real API response before treating as canonical.
const mockDevices = [
    {
        id: 'device-123',
        deviceType: 'ELECTRIC_VEHICLES',
        preferences: {
            schedules: [
                { dayOfWeek: 'MONDAY',    time: '07:30:00', max: 80 },
                { dayOfWeek: 'TUESDAY',   time: '07:30:00', max: 80 },
                { dayOfWeek: 'WEDNESDAY', time: '07:30:00', max: 80 },
                { dayOfWeek: 'THURSDAY',  time: '07:30:00', max: 80 },
                { dayOfWeek: 'FRIDAY',    time: '07:30:00', max: 80 },
                { dayOfWeek: 'SATURDAY',  time: '09:00:00', max: 80 },
                { dayOfWeek: 'SUNDAY',    time: '09:00:00', max: 80 },
            ]
        }
    }
];

const mockDispatches = [
    { start: '2099-12-10T02:00:00+00:00', end: '2099-12-10T03:00:00+00:00', energyAddedKwh: 5, type: 'SMART' },
    { start: '2099-12-10T05:00:00+00:00', end: '2099-12-10T06:00:00+00:00', energyAddedKwh: 5, type: 'SMART' },
];

const mockResponse = {
    devices: mockDevices,
    flexPlannedDispatches: mockDispatches
};

describe('intelligent category', () => {
    test('buildDevicesQuery returns query and account variable', () => {
        const { query, variables } = intelligent.buildDevicesQuery('A-AAA-1234');
        expect(query).toContain('devices');
        expect(query).not.toContain('flexPlannedDispatches');
        expect(variables.account).toBe('A-AAA-1234');
    });

    test('confirmed_limit is a number even when Kraken sends the schedule max as a string', () => {
        const devices = [{ id: 'd', deviceType: 'ELECTRIC_VEHICLES',
            preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '06:30:00', max: '85' }] } }];
        const result = intelligent.parseResponse({ devices, flexPlannedDispatches: [] }, { tz: 'UTC', serverTz: 'UTC' });
        expect(result.confirmed_limit).toBe(85);
    });

    test.each([[''], ['  '], [null], [0], ['abc']])('confirmed_limit falls back to 80 for unusable max %p (never sends 0)', (max) => {
        const devices = [{ id: 'd', deviceType: 'ELECTRIC_VEHICLES',
            preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '06:30:00', max }] } }];
        const result = intelligent.parseResponse({ devices, flexPlannedDispatches: [] }, { tz: 'UTC', serverTz: 'UTC' });
        expect(result.confirmed_limit).toBe(80);
    });

    test('buildDispatchQuery returns query and deviceId variable', () => {
        const { query, variables } = intelligent.buildDispatchQuery('device-123');
        expect(query).toContain('flexPlannedDispatches');
        expect(variables.deviceId).toBe('device-123');
    });

    test('parseResponse extracts slots and preferences', () => {
        const result = intelligent.parseResponse(mockResponse, { tz: 'UTC', serverTz: 'UTC' });
        expect(result.confirmed_limit).toBe(80);
        expect(result.confirmed_time).toBe('07:30');
        expect(result.total_energy).toBe(10);
        expect(result.slot1_start).not.toBeNull();
        expect(result.slot2_start).not.toBeNull();
        expect(result.slot3_start).toBeNull();
    });

    test('parseResponse with empty dispatches returns null fields', () => {
        const result = intelligent.parseResponse(
            { devices: mockDevices, flexPlannedDispatches: [] },
            { tz: 'UTC', serverTz: 'UTC' }
        );
        expect(result.next_start).toBeNull();
        expect(result.total_energy).toBe(0);
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(intelligent.parseResponse(
            { devices: [], flexPlannedDispatches: [] },
            { tz: 'UTC', serverTz: 'UTC' }
        ));
        const populatedKeys = Object.keys(intelligent.parseResponse(
            mockResponse,
            { tz: 'UTC', serverTz: 'UTC' }
        ));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(intelligent.defaultData).toHaveProperty(key);
        }
    });

    test('parseResponse handles null energyAddedKwh without crashing', () => {
        const result = intelligent.parseResponse(
            {
                devices: mockDevices,
                flexPlannedDispatches: [{ start: '2099-12-10T02:00:00+00:00', end: '2099-12-10T03:00:00+00:00', energyAddedKwh: null, type: 'SMART' }]
            },
            { tz: 'UTC', serverTz: 'UTC' }
        );
        expect(result.next_kwh).toBe('0');
    });

    // Live API returns energyAddedKwh as a string (verified empirically — see flex-planned-dispatches mock).
    // Naive `sum + (s.energyAddedKwh || 0)` would concatenate, producing a string with no .toFixed().
    test('parseResponse handles string energyAddedKwh from live API', () => {
        const result = intelligent.parseResponse(
            {
                devices: mockDevices,
                flexPlannedDispatches: [
                    { start: '2099-12-10T02:00:00+00:00', end: '2099-12-10T03:00:00+00:00', energyAddedKwh: '5.5', type: 'SMART' },
                    { start: '2099-12-10T05:00:00+00:00', end: '2099-12-10T06:00:00+00:00', energyAddedKwh: '4.5', type: 'SMART' }
                ]
            },
            { tz: 'UTC', serverTz: 'UTC' }
        );
        expect(result.total_energy).toBe(10);
        expect(result.next_kwh).toBe('5.50');
    });

    test('parseResponse handles negative string energyAddedKwh (export dispatch)', () => {
        const result = intelligent.parseResponse(
            {
                devices: mockDevices,
                flexPlannedDispatches: [
                    { start: '2099-12-10T02:00:00+00:00', end: '2099-12-10T03:00:00+00:00', energyAddedKwh: '-1.86375', type: 'SMART' },
                    { start: '2099-12-10T05:00:00+00:00', end: '2099-12-10T06:00:00+00:00', energyAddedKwh: '-2.2195', type: 'SMART' }
                ]
            },
            { tz: 'UTC', serverTz: 'UTC' }
        );
        expect(result.total_energy).toBeCloseTo(-4.08, 2);
        expect(result.next_kwh).toBe('-1.86');
    });

    test('parseResponse handles no EV device gracefully (defaults)', () => {
        const result = intelligent.parseResponse(
            { devices: [], flexPlannedDispatches: mockDispatches },
            { tz: 'UTC', serverTz: 'UTC' }
        );
        expect(result.confirmed_limit).toBe(80);
        expect(result.confirmed_time).toBe('07:30');
    });

    test('parseResponse time field normalised from HH:MM:SS to HH:MM', () => {
        const result = intelligent.parseResponse(mockResponse, { tz: 'UTC', serverTz: 'UTC' });
        expect(result.confirmed_time).toBe('07:30');
    });

    test('next_source is lowercased type value', () => {
        const result = intelligent.parseResponse(mockResponse, { tz: 'UTC', serverTz: 'UTC' });
        expect(result.next_source).toBe('smart');
    });

    test('extractEvDevice returns null when no EV device', () => {
        expect(intelligent.extractEvDevice([])).toBeNull();
        expect(intelligent.extractEvDevice([{ deviceType: 'BATTERIES' }])).toBeNull();
    });

    test('extractEvDevice finds EV device', () => {
        const ev = intelligent.extractEvDevice(mockDevices);
        expect(ev.id).toBe('device-123');
    });

    function withCap(value) {
        const chargeCap = value === undefined ? null : { isChargingDurationCapped: value };
        return { devices: [{ ...mockDevices[0], chargeCap }], flexPlannedDispatches: [] };
    }

    test('buildDevicesQuery requests Charge Cap under its own alias, apart from the schedules', () => {
        // isChargingDurationCapped is non-null: an error on it nulls its parent selection, so it
        // must not share one with schedules (live-verified alias, 2026-10-01).
        const q = intelligent.buildDevicesQuery('A-1').query;
        expect(q).toMatch(/chargeCap:\s*preferences\s*\{[^}]*isChargingDurationCapped/);
        expect(q.indexOf('isChargingDurationCapped')).toBeGreaterThan(q.indexOf('chargeCap:'));
        expect(q.match(/isChargingDurationCapped/g)).toHaveLength(1);
    });

    test.each([
        ['ENABLED', true],
        ['DISABLED', false],
        ['NOT_APPLICABLE', null],
        [undefined, null],
    ])('isChargingDurationCapped %p -> charge_cap %p', (raw, expected) => {
        const r = intelligent.parseResponse(withCap(raw), { tz: 'UTC', serverTz: 'UTC' });
        expect(r.charge_cap).toBe(expected);
    });

    test('charge_cap is null when there is no EV device', () => {
        const r = intelligent.parseResponse({ devices: [], flexPlannedDispatches: [] }, { tz: 'UTC', serverTz: 'UTC' });
        expect(r.charge_cap).toBeNull();
    });

    test('defaultData.charge_cap is null', () => {
        expect(intelligent.defaultData.charge_cap).toBeNull();
    });

});

describe('slotsChanged', () => {
    const NOW = Date.parse('2026-09-30T01:29:30Z');
    const plan = [
        { start: '2026-09-30T01:30:00+00:00', end: '2026-09-30T02:00:00+00:00', energyAddedKwh: '3.1' },
        { start: '2026-09-30T02:30:00+00:00', end: '2026-09-30T03:00:00+00:00', energyAddedKwh: '3.0' },
    ];

    test('same slots are unchanged, even with different energy or timestamp format', () => {
        const fresh = [
            { start: '2026-09-30T01:30:00Z', end: '2026-09-30T02:00:00Z', energyAddedKwh: '2.9' },
            { start: '2026-09-30T02:30:00Z', end: '2026-09-30T03:00:00Z', energyAddedKwh: '3.0' },
        ];
        expect(intelligent.slotsChanged(plan, fresh, NOW)).toBe(false);
    });

    test('a re-planned slot is a change (overnight 2026-09-30 case)', () => {
        const fresh = [{ start: '2026-09-30T02:00:00Z', end: '2026-09-30T02:30:00Z' }];
        expect(intelligent.slotsChanged(plan, fresh, NOW)).toBe(true);
    });

    test('a cancelled plan is a change', () => {
        expect(intelligent.slotsChanged(plan, [], NOW)).toBe(true);
    });

    test('slots that have already ended are ignored on both sides', () => {
        const withPast = [{ start: '2026-09-30T00:30:00Z', end: '2026-09-30T01:00:00Z' }, ...plan];
        expect(intelligent.slotsChanged(withPast, plan, NOW)).toBe(false);
    });

    test('missing lists are treated as empty', () => {
        expect(intelligent.slotsChanged(null, undefined, NOW)).toBe(false);
        expect(intelligent.slotsChanged(null, plan, NOW)).toBe(true);
    });
});
