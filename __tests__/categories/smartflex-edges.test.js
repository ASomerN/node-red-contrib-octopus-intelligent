// __tests__/categories/smartflex-edges.test.js
'use strict';
/**
 * Edge cases for the 1.7.0 SmartFlex categories not covered by smartflex-vehicle.test.js and
 * smartflex-inverter.test.js. Shapes follow the live devices response (vehicle, 6 Oct 2026)
 * and the introspected schema (inverter, NOT live-verified). Kraken sends Decimal fields as
 * strings, so most numbers here are strings; a few cases use real numbers too.
 * Partial errors follow Kraken: HTTP 200 body { data: {...with nulls}, errors: [{ message, path, extensions: { errorCode } }] }.
 */
const sv = require('../../lib/categories/smartflex-vehicle');
const si = require('../../lib/categories/smartflex-inverter');

const krakenError = (code, message, path) => ({ message, path, extensions: { errorType: 'APPLICATION', errorCode: code } });

const sessionNode = (start, end, extra = {}) => ({
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
    chargingSessions: { edges: [sessionNode('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00')] },
    ...overrides,
});

describe('smartflex-vehicle parseResponse edges', () => {
    test('a non-numeric string is null, not NaN', () => {
        const r = sv.parseResponse({ devices: [vehicle({ vehicleBatterySize: 'unknown', chargePointPowerOutput: 'n/a' })] }, 'dev-1');
        expect(r.vehicle_battery_kwh).toBeNull();
        expect(r.charger_power_kw).toBeNull();
    });

    test('numbers that arrive as real numbers are kept', () => {
        const r = sv.parseResponse({ devices: [vehicle({ vehicleBatterySize: 75, chargePointPowerOutput: 7.4 })] }, 'dev-1');
        expect(r.vehicle_battery_kwh).toBe(75);
        expect(r.charger_power_kw).toBe(7.4);
    });

    test('a SmartFlexChargePoint is used when it is the discovered device', () => {
        const cp = vehicle({ __typename: 'SmartFlexChargePoint', id: 'cp-1', make: 'Ohme', model: 'Home Pro' });
        const r = sv.parseResponse({ devices: [vehicle(), cp] }, 'cp-1');
        expect(r.vehicle_make).toBe('Ohme');
        expect(r.vehicle_model).toBe('Home Pro');
    });

    test('no discovered id: the first vehicle or charge point is used', () => {
        const inverter = { __typename: 'SmartFlexInverter', id: 'inv-1', make: 'GivEnergy' };
        const r = sv.parseResponse({ devices: [null, inverter, vehicle()] }, null);
        expect(r.vehicle_make).toBe('Tesla');
    });

    test('null session edges, nodes and sessions without a start are skipped', () => {
        const v = vehicle({ chargingSessions: { edges: [
            null,
            { node: null },
            sessionNode(null, '2026-10-06T04:00:00+01:00'),
            sessionNode('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00'),
        ] } });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.charging_sessions).toHaveLength(1);
        expect(r.last_session_kwh).toBe(13.5);
    });

    test('a session with an unparseable start sorts last', () => {
        const v = vehicle({ chargingSessions: { edges: [
            sessionNode('not-a-date', '2026-10-07T04:00:00+01:00', { energyAdded: { value: '1.00', unit: 'KILOWATT_HOUR' } }),
            sessionNode('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00'),
        ] } });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.charging_sessions.map((s) => s.start)).toEqual(['2026-10-05T23:30:00+01:00', 'not-a-date']);
        expect(r.last_session_kwh).toBe(13.5);
    });

    test('every session still in progress: no last session, but the list is kept', () => {
        const v = vehicle({ chargingSessions: { edges: [sessionNode('2026-10-06T23:30:00+01:00', null)] } });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.charging_sessions).toHaveLength(1);
        expect(r.charging_sessions[0].end).toBeNull();
        expect(r.last_session).toBeNull();
        expect(r.last_session_kwh).toBeNull();
        expect(r.last_session_soc_final).toBeNull();
        expect(r.last_session_problem).toBeNull();
    });

    test('last_session_problem is false (not null) for a clean completed session', () => {
        const r = sv.parseResponse({ devices: [vehicle()] }, 'dev-1');
        expect(r.last_session_problem).toBe(false);
    });

    test('null problem entries are dropped', () => {
        const v = vehicle({ chargingSessions: { edges: [
            sessionNode('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00', { problems: [null, { __typename: 'SmartFlexChargingTruncation' }] }),
        ] } });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.last_session.problems).toEqual(['SmartFlexChargingTruncation']);
        expect(r.last_session_problem).toBe(true);
    });

    test('session cost: string amount parsed, missing currency is null', () => {
        const v = vehicle({ chargingSessions: { edges: [
            sessionNode('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00', { cost: { amount: '1.875' } }),
        ] } });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.last_session.cost).toEqual({ amount: 1.875, currency: null });
    });

    test('session SoC change and final arrive as strings and are parsed', () => {
        const v = vehicle({ chargingSessions: { edges: [
            sessionNode('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00', { stateOfChargeChange: '-2.5', stateOfChargeFinal: '0' }),
        ] } });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.last_session.soc_change).toBe(-2.5);
        expect(r.last_session_soc_final).toBe(0);
    });

    test('session with no type or energy: nulls, not undefined', () => {
        const v = vehicle({ chargingSessions: { edges: [
            sessionNode('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00', { type: undefined, energyAdded: { value: '', unit: 'KILOWATT_HOUR' } }),
        ] } });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.last_session.type).toBeNull();
        expect(r.last_session_kwh).toBeNull();
    });

    test('energyAdded in WATT_HOUR is converted to kWh (string value)', () => {
        const v = vehicle({ chargingSessions: { edges: [
            sessionNode('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00', { energyAdded: { value: '13500', unit: 'WATT_HOUR' } }),
        ] } });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.last_session.kwh_added).toBe(13.5);
        expect(r.last_session_kwh).toBe(13.5);
    });

    test('energyAdded in KILOWATT_HOUR or with no unit is used as it is', () => {
        const v = vehicle({ chargingSessions: { edges: [
            sessionNode('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00', { energyAdded: { value: '7.25', unit: 'KILOWATT_HOUR' } }),
            sessionNode('2026-10-03T23:30:00+01:00', '2026-10-04T04:00:00+01:00', { energyAdded: { value: '6.5' } }),
        ] } });
        const r = sv.parseResponse({ devices: [v] }, 'dev-1');
        expect(r.charging_sessions.map((s) => s.kwh_added)).toEqual([7.25, 6.5]);
    });

    test('a WATT_HOUR value that is not a number is null', () => {
        const v = vehicle({ chargingSessions: { edges: [
            sessionNode('2026-10-05T23:30:00+01:00', '2026-10-06T04:00:00+01:00', { energyAdded: { value: 'n/a', unit: 'WATT_HOUR' } }),
        ] } });
        expect(sv.parseResponse({ devices: [v] }, 'dev-1').last_session_kwh).toBeNull();
    });

    test('null alert entries are dropped; missing alert fields are null', () => {
        const r = sv.parseResponse({ devices: [vehicle({ alerts: [null, {}, { message: 'Car unplugged', publishedAt: '2026-10-06T08:00:00+00:00' }] })] }, 'dev-1');
        // newest first; an alert with no date sorts last
        expect(r.device_alerts).toEqual([
            { message: 'Car unplugged', published_at: '2026-10-06T08:00:00+00:00' },
            { message: null, published_at: null },
        ]);
    });

    test('only the 10 newest alerts are kept, newest first', () => {
        const alerts = [];
        for (let i = 1; i <= 25; i++) {
            alerts.push({ message: `Alert ${i}`, publishedAt: `2026-10-${String(i).padStart(2, '0')}T08:00:00+00:00` });
        }
        const r = sv.parseResponse({ devices: [vehicle({ alerts })] }, 'dev-1');
        expect(r.device_alerts).toHaveLength(10);
        expect(r.device_alerts[0].message).toBe('Alert 25');
        expect(r.device_alerts[9].message).toBe('Alert 16');
    });

    test('a long alert message is cut to 250 characters', () => {
        const r = sv.parseResponse({ devices: [vehicle({ alerts: [{ message: 'x'.repeat(5000), publishedAt: '2026-10-06T08:00:00+00:00' }] })] }, 'dev-1');
        expect(r.device_alerts[0].message.length).toBeLessThanOrEqual(250);
        expect(r.device_alerts[0].message.endsWith('...')).toBe(true);
    });

    test('null data or no devices list gives fresh defaults', () => {
        expect(sv.parseResponse(null, 'dev-1')).toEqual(sv.defaultData);
        expect(sv.parseResponse({ devices: null }, 'dev-1')).toEqual(sv.defaultData);
    });

    test('the default lists are fresh arrays, not the shared defaultData ones', () => {
        const r = sv.parseResponse({ devices: [] }, 'dev-1');
        r.device_alerts.push({ message: 'x' });
        r.charging_sessions.push({ start: 'x' });
        expect(sv.defaultData.device_alerts).toEqual([]);
        expect(sv.defaultData.charging_sessions).toEqual([]);
    });
});

describe('smartflex-vehicle parseGraphqlResponse edges', () => {
    test('two failed fields: both are left out, and the error is the first one', () => {
        const v = vehicle({ alerts: null, chargingSessions: null });
        const body = {
            data: { devices: [v] },
            errors: [
                krakenError('KT-CT-4399', 'Unable to get alerts.', ['devices', 0, 'alerts']),
                krakenError('KT-CT-4301', 'Unable to fetch charging sessions.', ['devices', 0, 'chargingSessions']),
            ],
        };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        expect(r).not.toHaveProperty('device_alerts');
        expect(r).not.toHaveProperty('last_session_kwh');
        expect(r).not.toHaveProperty('charging_sessions');
        expect(r.vehicle_make).toBe('Tesla');
        expect(r.smartflex_vehicle_error).toBe('KT-CT-4399: Unable to get alerts');
    });

    test('a failed make or model is left out so the last value is kept', () => {
        const v = vehicle({ make: null });
        const body = { data: { devices: [v] }, errors: [krakenError('KT-CT-4399', 'Make unavailable.', ['devices', 0, 'make'])] };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        expect(r).not.toHaveProperty('vehicle_make');
        expect(r.vehicle_model).toBe('Model X');
    });

    test('a failed numeric field is left out; the other string numbers are still parsed', () => {
        const v = vehicle({ vehicleBatterySize: null, chargePointPowerOutput: '22.000' });
        const body = { data: { devices: [v] }, errors: [krakenError('KT-CT-4399', 'Battery size unavailable.', ['devices', 0, 'vehicleBatterySize'])] };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        expect(r).not.toHaveProperty('vehicle_battery_kwh');
        expect(r.charger_power_kw).toBe(22);
    });

    test('an error without a code reads "SmartFlex vehicle query failed: message"', () => {
        const v = vehicle({ chargingSessions: null });
        const body = { data: { devices: [v] }, errors: [{ message: 'Something went wrong.', path: ['devices', 0, 'chargingSessions'] }] };
        expect(sv.parseGraphqlResponse(body, 'dev-1').smartflex_vehicle_error)
            .toBe('SmartFlex vehicle query failed: Something went wrong');
    });

    test('an error with no path keeps every field and sets the error', () => {
        const body = { data: { devices: [vehicle()] }, errors: [krakenError('KT-CT-1199', 'Too many requests.', undefined)] };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        const clean = sv.parseResponse({ devices: [vehicle()] }, 'dev-1');
        expect({ ...r, smartflex_vehicle_error: null }).toEqual(clean);
        expect(r.smartflex_vehicle_error).toBe('KT-CT-1199: Too many requests');
    });

    test('an error on a field outside the payload (deviceType) keeps every field and sets the error', () => {
        const v = vehicle({ deviceType: null });
        const body = { data: { devices: [v] }, errors: [krakenError('KT-CT-4399', 'Device type unavailable.', ['devices', 0, 'deviceType'])] };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        expect(r.vehicle_make).toBe('Tesla');
        expect(r.device_alerts).toEqual([]);
        expect(r.last_session_kwh).toBe(13.5);
        expect(r.smartflex_vehicle_error).toBe('KT-CT-4399: Device type unavailable');
    });

    test('the error index follows the vehicle position in the list', () => {
        const inverter = { __typename: 'SmartFlexInverter', id: 'inv-1' };
        const v = vehicle({ alerts: null });
        const body = {
            data: { devices: [inverter, v] },
            errors: [krakenError('KT-CT-4399', 'Unable to get alerts.', ['devices', 1, 'alerts'])],
        };
        const r = sv.parseGraphqlResponse(body, 'dev-1');
        expect(r).not.toHaveProperty('device_alerts');
        expect(r.smartflex_vehicle_error).toBe('KT-CT-4399: Unable to get alerts');
    });

    test('errors present but data has no devices list throws', () => {
        const body = { data: {}, errors: [krakenError('KT-CT-4360', 'Unable to get devices.', ['devices'])] };
        expect(() => sv.parseGraphqlResponse(body, 'dev-1')).toThrow('KT-CT-4360: Unable to get devices');
    });

    test('an empty errors list is treated as a clean response', () => {
        const r = sv.parseGraphqlResponse({ data: { devices: [vehicle()] }, errors: [] }, 'dev-1');
        expect(r.smartflex_vehicle_error).toBeNull();
        expect(r.vehicle_make).toBe('Tesla');
    });

    test('no data with an empty errors list throws "missing data"', () => {
        expect(() => sv.parseGraphqlResponse({ data: null, errors: [] }, 'dev-1')).toThrow(/missing data/i);
    });

    // Was a FINDING (coverage draft): with a vehicle and a charge point (or two vehicles) on the
    // account, an error that nulls the DISCOVERED device (devices[1]) used to fall back to the
    // other SmartFlex device and return its data with no error. It must throw, so the last
    // values are kept.
    test('the discovered device nulled by an error does not fall back to another vehicle', () => {
        const other = vehicle({ id: 'cp-9', __typename: 'SmartFlexChargePoint', make: 'Ohme', model: 'Home Pro' });
        const body = {
            data: { devices: [other, null] },
            errors: [krakenError('KT-CT-4360', 'Unable to get device status.', ['devices', 1, 'status'])],
        };
        expect(() => sv.parseGraphqlResponse(body, 'dev-1')).toThrow('KT-CT-4360: Unable to get device status');
    });

    test('with errors and no discovered id, the first vehicle is still used', () => {
        const v = vehicle({ chargingSessions: null });
        const body = { data: { devices: [v] }, errors: [krakenError('KT-CT-4301', 'Unable to fetch charging sessions.', ['devices', 0, 'chargingSessions'])] };
        const r = sv.parseGraphqlResponse(body, null);
        expect(r.vehicle_make).toBe('Tesla');
        expect(r.smartflex_vehicle_error).toBe('KT-CT-4301: Unable to fetch charging sessions');
    });
});

// NOT LIVE-VERIFIED: inverter shapes follow the introspected schema only.
const inverter = (overrides = {}) => ({
    __typename: 'SmartFlexInverter',
    id: 'inv-1',
    make: 'GivEnergy',
    model: 'Gen 3',
    details: { solar: { peakSolarPowerInKw: '4.20' } },
    telemetry: {
        inverter: { connectionStatus: 'CONNECTED', powerInKw: '2.50' },
        battery: { connectionStatus: 'CONNECTED', powerInKw: '-1.20', stateOfCharge: '64.0' },
        solar: { powerInKw: '3.10' },
        grid: { powerInKw: '0.40' },
        site: { consumptionInKw: '1.80', exportInKw: '0.00' },
    },
    ...overrides,
});

describe('smartflex-inverter parseResponse edges', () => {
    test('ONLINE also counts as online', () => {
        const inv = inverter();
        inv.telemetry.inverter.connectionStatus = 'ONLINE';
        expect(si.parseResponse({ devices: [inv] }, 'inv-1').inverter_online).toBe(true);
    });

    test('connection status match is exact (lower case is not online)', () => {
        const inv = inverter();
        inv.telemetry.inverter.connectionStatus = 'connected';
        const r = si.parseResponse({ devices: [inv] }, 'inv-1');
        expect(r.inverter_connection_status).toBe('connected');
        expect(r.inverter_online).toBe(false);
    });

    test('an empty telemetry list gives null readings', () => {
        const r = si.parseResponse({ devices: [inverter({ telemetry: [] })] }, 'inv-1');
        expect(r.inverter_power_kw).toBeNull();
        expect(r.home_battery_soc).toBeNull();
        expect(r.inverter_online).toBeNull();
        expect(r.inverter_make).toBe('GivEnergy');
    });

    test('a null last entry in a telemetry list gives null readings', () => {
        const r = si.parseResponse({ devices: [inverter({ telemetry: [inverter().telemetry, null] })] }, 'inv-1');
        expect(r.solar_power_kw).toBeNull();
        expect(r.grid_power_kw).toBeNull();
    });

    test('per-reading lists (battery, details.solar) use the latest entry', () => {
        const inv = inverter({ details: [{ solar: [{ peakSolarPowerInKw: '3.00' }, { peakSolarPowerInKw: '5.50' }] }] });
        inv.telemetry.battery = [
            { connectionStatus: 'CONNECTED', powerInKw: '1.00', stateOfCharge: '40.0' },
            { connectionStatus: 'CONNECTED', powerInKw: '-0.75', stateOfCharge: '41.5' },
        ];
        const r = si.parseResponse({ devices: [inv] }, 'inv-1');
        expect(r.solar_peak_kw).toBe(5.5);
        expect(r.home_battery_power_kw).toBe(-0.75);
        expect(r.home_battery_soc).toBe(41.5);
    });

    test('non-numeric and empty strings are null; real numbers are kept', () => {
        const inv = inverter();
        inv.telemetry.solar = { powerInKw: 'n/a' };
        inv.telemetry.grid = { powerInKw: '' };
        inv.telemetry.site = { consumptionInKw: 1.25, exportInKw: 0 };
        const r = si.parseResponse({ devices: [inv] }, 'inv-1');
        expect(r.solar_power_kw).toBeNull();
        expect(r.grid_power_kw).toBeNull();
        expect(r.site_consumption_kw).toBe(1.25);
        expect(r.site_export_kw).toBe(0);
    });

    test('no discovered id: the first SmartFlexInverter is used, null entries skipped', () => {
        const r = si.parseResponse({ devices: [null, { __typename: 'SmartFlexVehicle', id: 'dev-1' }, inverter()] }, null);
        expect(r.inverter_make).toBe('GivEnergy');
    });

    test('null data gives defaults, and the defaults are a copy', () => {
        const r = si.parseResponse(null, 'inv-1');
        expect(r).toEqual(si.defaultData);
        r.inverter_make = 'changed';
        expect(si.defaultData.inverter_make).toBeNull();
    });

    test('missing make and model are null, not undefined', () => {
        const r = si.parseResponse({ devices: [inverter({ make: undefined, model: '' })] }, 'inv-1');
        expect(r.inverter_make).toBeNull();
        expect(r.inverter_model).toBeNull();
    });
});
