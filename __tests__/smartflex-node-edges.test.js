// __tests__/smartflex-node-edges.test.js
'use strict';
/**
 * SmartFlex vehicle / inverter categories through the real node: failure paths and the MQTT
 * discovery payloads of the two SmartFlex binary sensors, not covered by
 * smartflex-categories.test.js or discovery-snapshot.test.js. Kraken is mocked: HTTP 200
 * bodies { data, errors: [{ message, path, extensions: { errorCode } }] }, Decimal fields as
 * strings. The inverter shape is NOT live-verified (schema introspection only).
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { createHarness, pollDevice, DISCOVERED, ACCOUNT, STATUS } = require('./helpers/real-node');
const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');

const PREFIX = `nodered_${ACCOUNT}`;
const krakenError = (code, message, path) => ({ message, path, extensions: { errorType: 'APPLICATION', errorCode: code } });

const VEHICLE = {
    __typename: 'SmartFlexVehicle', id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES',
    alerts: [], make: 'Tesla', model: 'Model X', vehicleBatterySize: '72.50', chargePointPowerOutput: '7.400',
    chargingSessions: { edges: [{ node: {
        start: '2026-10-05T23:30:00+01:00', end: '2026-10-06T04:00:00+01:00',
        stateOfChargeChange: '21.8', stateOfChargeFinal: '90.1',
        energyAdded: { value: '13.50', unit: 'KILOWATT_HOUR' }, cost: null, type: 'SMART', problems: [],
    } }] },
};
const CHARGE_POINT = {
    ...VEHICLE, __typename: 'SmartFlexChargePoint', id: 'cp-9', deviceType: 'ELECTRIC_VEHICLES', make: 'Ohme', model: 'Home Pro',
};
// NOT LIVE-VERIFIED: schema-shaped inverter fixture.
const INVERTER = {
    __typename: 'SmartFlexInverter', id: 'inv-1', make: 'GivEnergy', model: 'Gen 3',
    details: { solar: { peakSolarPowerInKw: '4.20' } },
    telemetry: {
        inverter: { connectionStatus: 'CONNECTED', powerInKw: '2.50' },
        battery: { connectionStatus: 'CONNECTED', powerInKw: '-1.20', stateOfCharge: '64.0' },
        solar: { powerInKw: '3.10' }, grid: { powerInKw: '0.40' },
        site: { consumptionInKw: '1.80', exportInKw: '0.00' },
    },
};

let h;
let vehicleBody;   // () => GraphQL body for the vehicle query
let vehicleThrow;  // Error thrown by the transport for the vehicle query, or null
let inverterBody;  // () => GraphQL body for the inverter query

const lastWith = (key) => h.sends.filter((m) => m.payload && !m.debug && key in m.payload).pop().payload;
const configFor = (component, id) => {
    const calls = h.broker.client.publish.mock.calls.filter((c) => c[0] === `homeassistant/${component}/${PREFIX}_${id}/config`);
    return calls.length ? calls[calls.length - 1] : null;
};

async function pollAt(iso) {
    jest.setSystemTime(new Date(iso));
    await h.onTick();
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-06T09:00:00Z'));
    h = createHarness();
    vehicleBody = () => ({ data: { devices: [VEHICLE, INVERTER] } });
    vehicleThrow = null;
    inverterBody = () => ({ data: { devices: [VEHICLE, INVERTER] } });
    discoverProducts.mockResolvedValue({ ...DISCOVERED, vehicleDeviceId: 'dev-1', inverterDeviceId: 'inv-1' });
    const harnessReply = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, ...rest) => {
        if (/query smartflexVehicle\b/.test(body.query)) {
            if (vehicleThrow) throw vehicleThrow;
            return { data: vehicleBody(), status: 200 };
        }
        if (/query smartflexInverter\b/.test(body.query)) return { data: inverterBody(), status: 200 };
        return harnessReply(body, ...rest);
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

describe('smartflex_vehicle failures through the node', () => {
    test('a transport failure sets smartflex_vehicle_error and keeps every last value', async () => {
        await h.start();
        expect(lastWith('vehicle_make').vehicle_make).toBe('Tesla');

        vehicleThrow = new Error('Octopus API request timed out after 30s');
        await pollAt('2026-10-06T09:30:01Z');
        const p = lastWith('smartflex_vehicle_error');
        expect(p.smartflex_vehicle_error).toBe('Octopus API request timed out after 30s');
        expect(p.vehicle_make).toBe('Tesla');
        expect(p.vehicle_battery_kwh).toBe(72.5);
        expect(p.last_session_kwh).toBe(13.5);
    });

    test('an error with no code reads "SmartFlex vehicle query failed: message"', async () => {
        await h.start();
        vehicleBody = () => ({ data: null, errors: [{ message: 'Something went wrong.', path: ['devices'] }] });
        await pollAt('2026-10-06T09:30:01Z');
        expect(lastWith('smartflex_vehicle_error').smartflex_vehicle_error).toBe('SmartFlex vehicle query failed: Something went wrong');
    });

    test('the discovered vehicle is used when a charge point is listed first', async () => {
        vehicleBody = () => ({ data: { devices: [CHARGE_POINT, VEHICLE] } });
        await h.start();
        const p = lastWith('vehicle_make');
        expect(p.vehicle_make).toBe('Tesla');
        expect(p.vehicle_model).toBe('Model X');
    });

    test('string numbers reach the MQTT state document as numbers', async () => {
        await h.start();
        const state = h.statePublishes().pop();
        expect(state.vehicle_battery_kwh).toBe(72.5);
        expect(state.charger_power_kw).toBe(7.4);
        expect(state.last_session_soc_final).toBe(90.1);
        expect(state.smartflex_vehicle_error).toBeNull();
    });
});

// Review F1/F5: the vehicle query no longer selects status (an error on it nulled the whole
// device list); device_state comes from the charging poll's tolerated smartStatus alias.
describe('device_state comes from the charging poll', () => {
    let currentState;
    let devicesErrors;
    beforeEach(() => {
        currentState = 'SMART_CONTROL_IN_PROGRESS';
        devicesErrors = undefined;
        h.replies.devices = () => {
            const d = pollDevice();
            d.smartStatus = devicesErrors ? null : { isSuspended: false, currentState };
            return { data: { devices: [d] }, errors: devicesErrors };
        };
    });
    const vehicleQueries = () => graphqlPost.mock.calls.filter(([b]) => /query smartflexVehicle\b/.test(b.query)).length;
    const devicesQueries = () => graphqlPost.mock.calls.filter(([b]) => /SmartFlexDevicePreferences/.test(b.query)).length;

    test('every charging poll sets device_state, in step with boosting', async () => {
        await h.start();
        expect(lastWith('device_state').device_state).toBe('SMART_CONTROL_IN_PROGRESS');
        expect(lastWith('device_state').boosting).toBe(false);

        currentState = 'BOOSTING';
        await pollAt('2026-10-06T09:05:01Z'); // charging poll only; the vehicle poll is every 30 min
        const p = lastWith('device_state');
        expect(p.device_state).toBe('BOOSTING');
        expect(p.boosting).toBe(true);
        expect(vehicleQueries()).toBe(1);
    });

    test('a status error on the charging poll keeps the last device_state and leaves the vehicle poll alone', async () => {
        await h.start();
        devicesErrors = [krakenError('KT-CT-4360', 'Unable to get device status.', ['devices', 0, 'smartStatus'])];
        await pollAt('2026-10-06T09:30:01Z'); // charging and vehicle polls both due
        const p = lastWith('device_state');
        expect(p.device_state).toBe('SMART_CONTROL_IN_PROGRESS');
        expect(p.intelligent_error).toBeNull();
        expect(p.smartflex_vehicle_error).toBeNull();
        expect(p.vehicle_make).toBe('Tesla');
        expect(vehicleQueries()).toBe(2);
    });

    // Kraken lists a charge point as ELECTRIC_VEHICLES (its device type enum has no
    // CHARGE_POINTS), so a charge-point account has a charging poll like a car account, and
    // device_state comes from it. No separate device-state query is ever sent.
    describe('charge-point account (SmartFlexChargePoint listed as ELECTRIC_VEHICLES)', () => {
        beforeEach(() => {
            discoverProducts.mockResolvedValue({
                ...DISCOVERED, hasIntelligent: true, deviceId: 'cp-9', deviceSuspended: false,
                deviceCount: 1, vehicleDeviceId: 'cp-9', inverterDeviceId: null,
            });
            vehicleBody = () => ({ data: { devices: [CHARGE_POINT] } });
            h.replies.devices = () => ({ data: { devices: [{
                ...pollDevice(), id: 'cp-9', smartStatus: { isSuspended: false, currentState },
            }] } });
        });

        test('device_state comes from the charging poll, with the charger details', async () => {
            await h.start();
            expect(devicesQueries()).toBe(1);
            const p = lastWith('device_state');
            expect(p.device_state).toBe('SMART_CONTROL_IN_PROGRESS');
            expect(p.vehicle_make).toBe('Ohme');
            expect(p.vehicle_model).toBe('Home Pro');
            expect(p.smartflex_vehicle_error).toBeNull();
        });

        test('the Boost Charge switch is announced', async () => {
            await h.start();
            const call = configFor('switch', 'boost');
            expect(call).not.toBeNull();
            expect(JSON.parse(call[1]).unique_id).toBe(`${PREFIX}_boost`);
        });

        test('no separate device-state query is sent', async () => {
            await h.start();
            await pollAt('2026-10-06T09:30:01Z');
            const queries = graphqlPost.mock.calls.map(([b]) => b.query || '');
            expect(queries.filter((q) => /query smartflexDeviceState\b/.test(q))).toHaveLength(0);
        });
    });

    test('an EV account does not send a separate device-state query (the charging poll sets device_state)', async () => {
        await h.start();
        expect(graphqlPost.mock.calls.filter(([b]) => /query smartflexDeviceState\b/.test(b.query))).toHaveLength(0);
    });

    test('the vehicle query does not select status', async () => {
        await h.start();
        const [body] = graphqlPost.mock.calls.find(([b]) => /query smartflexVehicle\b/.test(b.query));
        expect(body.query).not.toMatch(/\bstatus\s*\{/);
    });
});

describe('smartflex_inverter failures through the node (experimental)', () => {
    const start = () => h.start({ enableSmartflexInverter: true });

    test('a full GraphQL failure sets a short smartflex_inverter_error and keeps the last values', async () => {
        await start();
        expect(lastWith('home_battery_soc').home_battery_soc).toBe(64);

        inverterBody = () => ({ data: null, errors: [krakenError('KT-CT-1111', 'Unauthorized.', ['devices'])] });
        await pollAt('2026-10-06T09:05:01Z');
        const p = lastWith('smartflex_inverter_error');
        expect(p.smartflex_inverter_error).toBe('KT-CT-1111: Unauthorized');
        expect(p.inverter_make).toBe('GivEnergy');
        expect(p.home_battery_soc).toBe(64);
    });

    test('a partial error (data with errors) fails the whole inverter poll: last values kept', async () => {
        await start();
        inverterBody = () => ({
            data: { devices: [VEHICLE, { ...INVERTER, telemetry: null, make: 'Changed' }] },
            errors: [krakenError('KT-CT-4360', 'Unable to get telemetry.', ['devices', 1, 'telemetry'])],
        });
        await pollAt('2026-10-06T09:05:01Z');
        const p = lastWith('smartflex_inverter_error');
        expect(p.smartflex_inverter_error).toBe('KT-CT-4360: Unable to get telemetry');
        expect(p.inverter_make).toBe('GivEnergy');
        expect(p.solar_power_kw).toBe(3.1);
    });

    test('the next clean poll clears the error and takes the new string values', async () => {
        await start();
        inverterBody = () => ({ data: null, errors: [krakenError('KT-CT-1111', 'Unauthorized.', ['devices'])] });
        await pollAt('2026-10-06T09:05:01Z');
        inverterBody = () => ({ data: { devices: [{ ...INVERTER, telemetry: { ...INVERTER.telemetry, battery: { connectionStatus: 'CONNECTED', powerInKw: '0.50', stateOfCharge: '70.5' } } }] } });
        await pollAt('2026-10-06T09:10:01Z');
        const p = lastWith('smartflex_inverter_error');
        expect(p.smartflex_inverter_error).toBeNull();
        expect(p.home_battery_soc).toBe(70.5);
        expect(p.home_battery_power_kw).toBe(0.5);
    });

    test('a vehicle failure does not touch the inverter error, and the other way round', async () => {
        await start();
        vehicleThrow = new Error('boom');
        await pollAt('2026-10-06T09:30:01Z'); // both due: vehicle 30 min, inverter 5 min
        const p = lastWith('smartflex_vehicle_error');
        expect(p.smartflex_vehicle_error).toBe('boom');
        expect(p.smartflex_inverter_error).toBeNull();
    });
});

describe('SmartFlex binary sensor discovery payloads', () => {
    test('Last Charge Session Problem: problem class on the single device, Python-style True/False', async () => {
        await h.start();
        const call = configFor('binary_sensor', 'last_session_problem');
        expect(call).not.toBeNull();
        expect(call[2]).toEqual({ retain: true });
        const cfg = JSON.parse(call[1]);
        expect(cfg).toMatchObject({
            name: 'Octopus Last Charge Session Problem',
            unique_id: `${PREFIX}_last_session_problem`,
            state_topic: STATUS,
            value_template: '{{ value_json.last_session_problem if value_json.last_session_problem is defined else None }}',
            payload_on: 'True',
            payload_off: 'False',
            device_class: 'problem',
            availability: [{ topic: STATUS, value_template: "{{ 'online' if value_json.last_session_problem is defined else 'offline' }}" }],
        });
        expect(cfg.device.identifiers).toEqual([`nodered_octopus_${ACCOUNT}`]);
        // Review L5: no icon, so Home Assistant shows the problem class's OK / Problem icons.
        expect(cfg.icon).toBeUndefined();
    });

    test('Inverter Online: connectivity class, diagnostic, only with the option ticked', async () => {
        await h.start({ enableSmartflexInverter: true });
        const call = configFor('binary_sensor', 'inverter_online');
        expect(call).not.toBeNull();
        const cfg = JSON.parse(call[1]);
        expect(cfg).toMatchObject({
            name: 'Octopus Inverter Online',
            unique_id: `${PREFIX}_inverter_online`,
            state_topic: STATUS,
            value_template: '{{ value_json.inverter_online if value_json.inverter_online is defined else None }}',
            payload_on: 'True',
            payload_off: 'False',
            device_class: 'connectivity',
            entity_category: 'diagnostic',
            availability: [{ topic: STATUS, value_template: "{{ 'online' if value_json.inverter_online is defined else 'offline' }}" }],
        });
        expect(cfg.device.identifiers).toEqual([`nodered_octopus_${ACCOUNT}`]);
    });

    test('option off: the Inverter Online topic is cleared with a retained empty payload', async () => {
        await h.start();
        const call = configFor('binary_sensor', 'inverter_online');
        expect(call).toEqual([`homeassistant/binary_sensor/${PREFIX}_inverter_online/config`, '', { retain: true }]);
    });

    // Review F3: a retained empty config DELETES the entity in Home Assistant (names, areas and
    // ids are lost). A transient empty device list must not do that.
    test('an empty device list leaves the vehicle and inverter entities alone and logs it', async () => {
        discoverProducts.mockResolvedValue({
            ...DISCOVERED, hasIntelligent: false, deviceId: null, deviceSuspended: null,
            deviceCount: 0, vehicleDeviceId: null, inverterDeviceId: null,
        });
        await h.start({ enableSmartflexInverter: true });
        expect(configFor('binary_sensor', 'last_session_problem')).toBeNull();
        expect(configFor('sensor', 'vehicle_make')).toBeNull();
        expect(configFor('binary_sensor', 'smartflex_vehicle_error_state')).toBeNull();
        expect(configFor('binary_sensor', 'inverter_online')).toBeNull();
        expect(configFor('sensor', 'home_battery_soc')).toBeNull();
        expect(h.logs.some((l) => /listed no devices/.test(l))).toBe(true);
    });

    test('devices listed but no vehicle (inverter only): the vehicle topics are cleared', async () => {
        discoverProducts.mockResolvedValue({
            ...DISCOVERED, hasIntelligent: false, deviceId: null, deviceSuspended: null,
            deviceCount: 1, vehicleDeviceId: null, inverterDeviceId: 'inv-1',
        });
        await h.start({ enableSmartflexInverter: true });
        expect(configFor('binary_sensor', 'last_session_problem')).toEqual([`homeassistant/binary_sensor/${PREFIX}_last_session_problem/config`, '', { retain: true }]);
        expect(configFor('sensor', 'vehicle_make')).toEqual([`homeassistant/sensor/${PREFIX}_vehicle_make/config`, '', { retain: true }]);
        expect(JSON.parse(configFor('binary_sensor', 'inverter_online')[1]).unique_id).toBe(`${PREFIX}_inverter_online`);
    });

    test('an empty device list with the inverter option off still clears the inverter topics', async () => {
        discoverProducts.mockResolvedValue({
            ...DISCOVERED, hasIntelligent: false, deviceId: null, deviceSuspended: null,
            deviceCount: 0, vehicleDeviceId: null, inverterDeviceId: null,
        });
        await h.start();
        expect(configFor('binary_sensor', 'inverter_online')).toEqual([`homeassistant/binary_sensor/${PREFIX}_inverter_online/config`, '', { retain: true }]);
        expect(configFor('binary_sensor', 'last_session_problem')).toBeNull();
    });

    test('no vehicle: the Last Charge Session Problem topic is cleared with a retained empty payload', async () => {
        discoverProducts.mockResolvedValue({ ...DISCOVERED, vehicleDeviceId: null, inverterDeviceId: null });
        await h.start();
        const call = configFor('binary_sensor', 'last_session_problem');
        expect(call).toEqual([`homeassistant/binary_sensor/${PREFIX}_last_session_problem/config`, '', { retain: true }]);
    });
});
