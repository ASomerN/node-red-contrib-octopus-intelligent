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

    // total_energy counts a non-numeric energyAddedKwh as 0; next_kwh must not publish "NaN".
    test.each([['abc'], [''], ['  ']])('a non-numeric energyAddedKwh %p gives next_kwh "0", never "NaN"', (raw) => {
        const result = intelligent.parseResponse(
            {
                devices: mockDevices,
                flexPlannedDispatches: [
                    { start: '2099-12-10T02:00:00+00:00', end: '2099-12-10T03:00:00+00:00', energyAddedKwh: raw, type: 'SMART' },
                    { start: '2099-12-10T05:00:00+00:00', end: '2099-12-10T06:00:00+00:00', energyAddedKwh: '4.5', type: 'SMART' }
                ]
            },
            { tz: 'UTC', serverTz: 'UTC' }
        );
        expect(result.next_kwh).toBe('0');
        expect(result.total_energy).toBe(4.5);
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

    test('buildDevicesQuery(account, false) leaves out the device status and keeps the rest', () => {
        const withStatus = intelligent.buildDevicesQuery('A-1').query;
        const { query, variables } = intelligent.buildDevicesQuery('A-1', false);
        expect(withStatus).toMatch(/smartStatus:\s*status\s*\{\s*isSuspended\s+currentState\s*\}/);
        expect(query).not.toMatch(/status/i);
        expect(query).toMatch(/schedules/);
        expect(query).toMatch(/chargeCap:\s*preferences/);
        expect(query).toMatch(/query getDevices/);
        expect(variables).toEqual({ account: 'A-1' });
    });

    describe('statusNulledDevices', () => {
        // KT-CT-4360 on the non-null status: Kraken nulls the whole device list.
        const statusError = (path) => ({ message: 'Device status could not be fetched.', path,
            extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-4360' } });

        test('true for a null list with an error on smartStatus or status', () => {
            expect(intelligent.statusNulledDevices([statusError(['devices', 0, 'smartStatus'])], { devices: null })).toBe(true);
            expect(intelligent.statusNulledDevices([statusError(['devices', 0, 'status', 'isSuspended'])], { devices: null })).toBe(true);
            expect(intelligent.statusNulledDevices([statusError(['devices', 0, 'smartStatus'])], null)).toBe(true);
        });

        test('true when a preferences error comes with it', () => {
            const errors = [statusError(['devices', 0, 'smartStatus']),
                { message: 'Your device charging preferences could not be fetched.', path: ['devices', 0, 'preferences'], extensions: { errorCode: 'KT-CT-4339' } }];
            expect(intelligent.statusNulledDevices(errors, { devices: null })).toBe(true);
        });

        test('false when the list is present, the error is elsewhere, or there are no errors', () => {
            expect(intelligent.statusNulledDevices([statusError(['devices', 0, 'smartStatus', 'isSuspended'])], { devices: [] })).toBe(false);
            expect(intelligent.statusNulledDevices([{ message: 'Unauthorized.', path: ['devices'] }], { devices: null })).toBe(false);
            expect(intelligent.statusNulledDevices([statusError(['devices', 0, 'smartStatus']), { message: 'x', path: ['account'] }], { devices: null })).toBe(false);
            expect(intelligent.statusNulledDevices([{ message: 'x' }], { devices: null })).toBe(false);
            expect(intelligent.statusNulledDevices(undefined, { devices: null })).toBe(false);
            expect(intelligent.statusNulledDevices([], { devices: null })).toBe(false);
        });
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

    function withBoostState(currentState) {
        const smartStatus = currentState === undefined ? null : { isSuspended: false, currentState };
        return { devices: [{ ...mockDevices[0], smartStatus }], flexPlannedDispatches: [] };
    }

    test('buildDevicesQuery reads status { isSuspended currentState } once, under the smartStatus alias', () => {
        // Kept apart so a status resolver error (KT-CT-4360) cannot blank the schedules.
        const q = intelligent.buildDevicesQuery('A-1').query;
        expect(q).toMatch(/smartStatus:\s*status\s*\{\s*isSuspended\s+currentState\s*\}/);
        expect(q.match(/status\s*\{/g)).toHaveLength(1);
    });

    test.each([
        ['BOOSTING', true],
        ['SMART_CONTROL_CAPABLE', false],
        ['SMART_CONTROL_IN_PROGRESS', false],
        ['LOST_CONNECTION', false],
        [undefined, null],
    ])('currentState %p -> boosting %p', (raw, expected) => {
        const r = intelligent.parseResponse(withBoostState(raw), { tz: 'UTC', serverTz: 'UTC' });
        expect(r.boosting).toBe(expected);
    });

    test('boosting is null when there is no EV device', () => {
        const r = intelligent.parseResponse({ devices: [], flexPlannedDispatches: [] }, { tz: 'UTC', serverTz: 'UTC' });
        expect(r.boosting).toBeNull();
    });

    test('defaultData.boosting is null', () => {
        expect(intelligent.defaultData.boosting).toBeNull();
    });

    // device_state comes from the same status.currentState as boosting, so the two always agree.
    test.each([
        ['BOOSTING', 'BOOSTING'],
        ['SMART_CONTROL_IN_PROGRESS', 'SMART_CONTROL_IN_PROGRESS'],
        ['LOST_CONNECTION', 'LOST_CONNECTION'],
        [undefined, null],
        ['', null],
    ])('currentState %p -> device_state %p', (raw, expected) => {
        const r = intelligent.parseResponse(withBoostState(raw), { tz: 'UTC', serverTz: 'UTC' });
        expect(r.device_state).toBe(expected);
    });

    test('device_state is null when there is no EV device, and in defaultData', () => {
        const r = intelligent.parseResponse({ devices: [], flexPlannedDispatches: [] }, { tz: 'UTC', serverTz: 'UTC' });
        expect(r.device_state).toBeNull();
        expect(intelligent.defaultData.device_state).toBeNull();
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

// Review L4: the charging poll uses the EV that discovery picked (the LIVE one), so the
// switch, preferences, boost state and dispatches all describe the same device.
describe('extractEvDevice with the discovered device id', () => {
    const oldCar = {
        id: 'old-car', deviceType: 'ELECTRIC_VEHICLES',
        preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '06:00:00', max: 50 }] },
        smartStatus: { isSuspended: true, currentState: 'SMART_CONTROL_CAPABLE' },
    };
    const newCar = {
        id: 'new-car', deviceType: 'ELECTRIC_VEHICLES',
        preferences: { schedules: [{ dayOfWeek: 'MONDAY', time: '08:30:00', max: 90 }] },
        smartStatus: { isSuspended: false, currentState: 'BOOSTING' },
    };

    test('picks the device with that id', () => {
        expect(intelligent.extractEvDevice([oldCar, newCar], 'new-car')).toBe(newCar);
    });

    test('falls back to the first EV when the id is missing or not listed', () => {
        expect(intelligent.extractEvDevice([oldCar, newCar])).toBe(oldCar);
        expect(intelligent.extractEvDevice([oldCar, newCar], 'gone')).toBe(oldCar);
    });

    test('never picks a device of another type, even with that id', () => {
        const hp = { id: 'new-car', deviceType: 'HEAT_PUMPS' };
        expect(intelligent.extractEvDevice([hp, oldCar], 'new-car')).toBe(oldCar);
    });

    test('extractSuspended reads the discovered device', () => {
        expect(intelligent.extractSuspended([oldCar, newCar], 'new-car')).toBe(false);
        expect(intelligent.extractSuspended([oldCar, newCar])).toBe(true);
    });

    test('parseResponse reads preferences and status of the discovered device', () => {
        const r = intelligent.parseResponse({ devices: [oldCar, newCar], flexPlannedDispatches: [] },
            { tz: 'UTC', serverTz: 'UTC', evId: 'new-car' });
        expect(r.confirmed_limit).toBe(90);
        expect(r.confirmed_time).toBe('08:30');
        expect(r.boosting).toBe(true);
        expect(r.device_state).toBe('BOOSTING');
    });
});
