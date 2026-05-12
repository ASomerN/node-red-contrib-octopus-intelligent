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

});
