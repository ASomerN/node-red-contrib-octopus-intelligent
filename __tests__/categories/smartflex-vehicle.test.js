// __tests__/categories/smartflex-vehicle.test.js
'use strict';
const sv = require('../../lib/categories/smartflex-vehicle');

// Shape mirrors a live devices response (6 Oct 2026, Tesla Model X). Ids and account are fake.
// Kraken sends Decimal fields as strings, so every numeric value here is a string.
const session = (start, end, extra = {}) => ({
    node: {
        start,
        end,
        stateOfChargeChange: '21.8',
        stateOfChargeFinal: '90.1',
        energyAdded: { value: '13.50', unit: 'KILOWATT_HOUR' },
        cost: null,
        type: 'SMART',
        problems: [],
        ...extra,
    },
});

const vehicle = (overrides = {}) => ({
    __typename: 'SmartFlexVehicle',
    id: 'dev-1',
    deviceType: 'ELECTRIC_VEHICLES',
    alerts: [],
    make: 'Tesla',
    model: 'Model X',
    vehicleBatterySize: '72.50',
    chargePointPowerOutput: '7.400',
    chargingSessions: {
        edges: [
            session('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00'),
            session('2026-10-03T23:30:00+01:00', '2026-10-04T03:00:00+01:00', {
                stateOfChargeChange: '10.0',
                stateOfChargeFinal: '80.0',
                energyAdded: { value: '7.25', unit: 'KILOWATT_HOUR' },
                problems: [{ __typename: 'SmartFlexChargingTruncation' }],
            }),
        ],
    },
    ...overrides,
});

const mockResponse = { devices: [vehicle()] };

describe('smartflex-vehicle category', () => {
    test('buildQuery asks for vehicle, charge point, alerts and sessions', () => {
        const { query, variables } = sv.buildQuery('A-FAKE0001');
        expect(variables).toEqual({ account: 'A-FAKE0001' });
        expect(query).toContain('devices(accountNumber: $account)');
        expect(query).toContain('... on SmartFlexVehicle');
        expect(query).toContain('... on SmartFlexChargePoint');
        expect(query).toContain('alerts');
        expect(query).toContain('chargingSessions(last: 5)');
        expect(query).toContain('stateOfChargeFinal');
        expect(query).toContain('problems');
    });

    test('buildQuery does not select status: an error on it would null the whole device list', () => {
        // device_state comes from the charging poll's tolerated smartStatus alias instead.
        const { query } = sv.buildQuery('A-FAKE0001');
        expect(query).not.toMatch(/\bstatus\s*\{/);
        expect(query).not.toContain('currentState');
    });

    test('buildQuery name does not collide with the intelligent getDevices query', () => {
        expect(sv.buildQuery('A-FAKE0001').query).not.toMatch(/getDevices|SmartFlexDevicePreferences|getDispatches/);
    });

    test('parseResponse extracts vehicle details', () => {
        const r = sv.parseResponse(mockResponse, 'dev-1');
        expect(r.vehicle_make).toBe('Tesla');
        expect(r.vehicle_model).toBe('Model X');
        expect(r).not.toHaveProperty('device_state'); // set by the charging poll
        expect(r.device_alerts).toEqual([]);
        expect(r.smartflex_vehicle_error).toBeNull();
    });

    test('parseResponse parses string battery size and charger power to numbers', () => {
        const r = sv.parseResponse(mockResponse, 'dev-1');
        expect(r.vehicle_battery_kwh).toBe(72.5);
        expect(r.charger_power_kw).toBe(7.4);
    });

    test('parseResponse maps sessions newest first with numeric string fields parsed', () => {
        const r = sv.parseResponse(mockResponse, 'dev-1');
        expect(r.charging_sessions).toHaveLength(2);
        expect(r.charging_sessions[0]).toEqual({
            start: '2026-10-05T23:30:00+01:00',
            end: '2026-10-06T04:00:00+01:00',
            kwh_added: 13.5,
            soc_change: 21.8,
            soc_final: 90.1,
            type: 'SMART',
            cost: null,
            problems: [],
        });
        expect(r.charging_sessions[1].problems).toEqual(['SmartFlexChargingTruncation']);
        expect(r.charging_sessions[1].kwh_added).toBe(7.25);
    });

    test('parseResponse sorts sessions newest first whatever order Kraken returns', () => {
        const v = vehicle();
        v.chargingSessions.edges.reverse();
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.charging_sessions[0].start).toBe('2026-10-05T23:30:00+01:00');
    });

    test('last_session is the newest completed session, with flat fields for MQTT', () => {
        const r = sv.parseResponse(mockResponse, 'dev-1');
        expect(r.last_session.start).toBe('2026-10-05T23:30:00+01:00');
        expect(r.last_session_kwh).toBe(13.5);
        expect(r.last_session_soc_final).toBe(90.1);
        expect(r.last_session_problem).toBe(false);
    });

    test('last_session skips a session still in progress (no end)', () => {
        const v = vehicle();
        v.chargingSessions.edges.unshift(session('2026-10-06T23:30:00+01:00', null));
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.charging_sessions).toHaveLength(3);
        expect(r.last_session.start).toBe('2026-10-05T23:30:00+01:00');
    });

    test('last_session_problem is true when the latest session was truncated', () => {
        const v = vehicle();
        v.chargingSessions.edges[0].node.problems = [{ __typename: 'SmartFlexChargingTruncation' }];
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.last_session_problem).toBe(true);
        expect(r.last_session.problems).toEqual(['SmartFlexChargingTruncation']);
    });

    test('session cost amount arrives as a string and is parsed', () => {
        const v = vehicle();
        v.chargingSessions.edges[0].node.cost = { amount: '1.23', currency: 'GBP' };
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.last_session.cost).toEqual({ amount: 1.23, currency: 'GBP' });
    });

    test('alerts map to message and published_at', () => {
        const v = vehicle({ alerts: [{ message: 'Car lost connection', publishedAt: '2026-10-06T08:00:00+01:00' }] });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.device_alerts).toEqual([{ message: 'Car lost connection', published_at: '2026-10-06T08:00:00+01:00' }]);
    });

    test('picks the discovered device id when several devices are returned', () => {
        const other = vehicle({ id: 'dev-2', make: 'Other', model: 'Car' });
        const r = sv.parseResponse({ devices: [other, vehicle()] }, 'dev-1');
        expect(r.vehicle_make).toBe('Tesla');
    });

    test('falls back to the first vehicle or charge point when the id is not found', () => {
        const inverter = { __typename: 'SmartFlexInverter', id: 'inv-1', status: null, alerts: [] };
        const cp = vehicle({ __typename: 'SmartFlexChargePoint', id: 'cp-9', make: 'Ohme', model: 'Home Pro' });
        const r = sv.parseResponse({ devices: [inverter, cp] }, 'dev-unknown');
        expect(r.vehicle_make).toBe('Ohme');
    });

    test('handles null and empty numeric strings as null', () => {
        const v = vehicle({ vehicleBatterySize: null, chargePointPowerOutput: '' });
        v.chargingSessions.edges[0].node.energyAdded = null;
        v.chargingSessions.edges[0].node.stateOfChargeFinal = null;
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.vehicle_battery_kwh).toBeNull();
        expect(r.charger_power_kw).toBeNull();
        expect(r.last_session_kwh).toBeNull();
        expect(r.last_session_soc_final).toBeNull();
    });

    test('handles null alerts and chargingSessions', () => {
        const v = vehicle({ alerts: null, chargingSessions: null });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.device_alerts).toEqual([]);
        expect(r.charging_sessions).toEqual([]);
        expect(r.last_session).toBeNull();
        expect(r.last_session_kwh).toBeNull();
        expect(r.last_session_problem).toBeNull();
    });

    test('returns defaults when there is no vehicle device', () => {
        const r = sv.parseResponse({ devices: [] }, 'dev-1');
        expect(r).toEqual(sv.defaultData);
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(sv.parseResponse({}, 'dev-1'));
        const populatedKeys = Object.keys(sv.parseResponse(mockResponse, 'dev-1'));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(sv.defaultData).toHaveProperty(key);
        }
    });
});

// Kraken partial errors: HTTP 200 with { data: {...with nulls}, errors: [{ message, path, extensions }] }.
// A failed field resolver nulls that field (or its nearest nullable parent) and lists an error.
const krakenError = (code, message, path) => ({ message, path, extensions: { errorType: 'APPLICATION', errorCode: code } });

describe('smartflex-vehicle parseGraphqlResponse (partial errors)', () => {
    test('a clean response parses as parseResponse does, with no error', () => {
        const r = sv.parseGraphqlResponse({ data: mockResponse }, 'dev-1');
        expect(r).toEqual(sv.parseResponse(mockResponse, 'dev-1'));
        expect(r.smartflex_vehicle_error).toBeNull();
    });

    test('chargingSessions error: keeps the fields that came back, leaves session fields out, short error', () => {
        const v = vehicle({ chargingSessions: null });
        const body = {
            data: { devices: [v] },
            errors: [krakenError('KT-CT-4301', 'Unable to fetch charging sessions.', ['devices', 0, 'chargingSessions'])],
        };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        expect(r.vehicle_make).toBe('Tesla');
        expect(r.vehicle_battery_kwh).toBe(72.5);
        expect(r.device_alerts).toEqual([]);
        // left out, so the merge keeps the last known values
        for (const k of ['charging_sessions', 'last_session', 'last_session_kwh', 'last_session_soc_final', 'last_session_problem']) {
            expect(r).not.toHaveProperty(k);
        }
        expect(r.smartflex_vehicle_error).toBe('KT-CT-4301: Unable to fetch charging sessions');
    });

    test('alerts error: device_alerts is left out, sessions still parsed', () => {
        const v = vehicle({ alerts: null });
        const body = {
            data: { devices: [v] },
            errors: [krakenError('KT-CT-4399', 'Unable to get alerts.', ['devices', 0, 'alerts'])],
        };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        expect(r).not.toHaveProperty('device_alerts');
        expect(r).not.toHaveProperty('device_state');
        expect(r.last_session_kwh).toBe(13.5);
        expect(r.smartflex_vehicle_error).toBe('KT-CT-4399: Unable to get alerts');
    });

    test('an error deeper in a session keeps the sessions that came back', () => {
        const v = vehicle();
        v.chargingSessions.edges[0].node.cost = null;
        const body = {
            data: { devices: [v] },
            errors: [krakenError('KT-CT-4301', 'Cost unavailable.', ['devices', 0, 'chargingSessions', 'edges', 0, 'node', 'cost'])],
        };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        expect(r.charging_sessions).toHaveLength(2);
        expect(r.last_session_kwh).toBe(13.5);
        expect(r.smartflex_vehicle_error).toBe('KT-CT-4301: Cost unavailable');
    });

    test('numeric fields that come back as strings are still parsed in a partial response', () => {
        const v = vehicle({ alerts: null, vehicleBatterySize: '60.0', chargePointPowerOutput: '11.000' });
        const body = { data: { devices: [v] }, errors: [krakenError('KT-CT-4399', 'Alerts failed.', ['devices', 0, 'alerts'])] };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        expect(r.vehicle_battery_kwh).toBe(60);
        expect(r.charger_power_kw).toBe(11);
        expect(r).not.toHaveProperty('device_alerts');
    });

    test('an error on another device does not affect this vehicle', () => {
        const inverter = { __typename: 'SmartFlexInverter', id: 'inv-1', status: null, alerts: [] };
        const body = {
            data: { devices: [inverter, vehicle()] },
            errors: [krakenError('KT-CT-4360', 'Unable to get device status.', ['devices', 0, 'status'])],
        };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        expect(r).toEqual(sv.parseResponse({ devices: [inverter, vehicle()] }, 'dev-1'));
        expect(r.smartflex_vehicle_error).toBeNull();
    });

    test('the error text stays under 255 characters', () => {
        const v = vehicle({ chargingSessions: null });
        const body = {
            data: { devices: [v] },
            errors: [krakenError('KT-CT-4301', 'x'.repeat(1000), ['devices', 0, 'chargingSessions'])],
        };
        expect(sv.parseGraphqlResponse(body, 'dev-1').smartflex_vehicle_error.length).toBeLessThan(255);
    });

    test('full failure (no data) throws a short "CODE: message" error', () => {
        const body = { data: null, errors: [krakenError('KT-CT-1111', 'Unauthorized.', ['devices'])] };
        expect(() => sv.parseGraphqlResponse(body, 'dev-1')).toThrow(/^KT-CT-1111: Unauthorized$/);
    });

    test('device list nulled by the error throws', () => {
        const body = { data: { devices: null }, errors: [krakenError('KT-CT-4360', 'Unable to get device status.', ['devices', 0, 'status'])] };
        expect(() => sv.parseGraphqlResponse(body, 'dev-1')).toThrow('KT-CT-4360: Unable to get device status');
    });

    test('the vehicle itself nulled by the error throws instead of blanking the last values', () => {
        const body = { data: { devices: [null] }, errors: [krakenError('KT-CT-4360', 'Unable to get device status.', ['devices', 0, 'status'])] };
        expect(() => sv.parseGraphqlResponse(body, 'dev-1')).toThrow('KT-CT-4360: Unable to get device status');
    });

    test('no data and no errors throws', () => {
        expect(() => sv.parseGraphqlResponse({}, 'dev-1')).toThrow(/missing data/i);
    });
});
