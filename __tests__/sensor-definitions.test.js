// __tests__/sensor-definitions.test.js
'use strict';
const {
    sensors, errorSensors, vehicleSensors, vehicleErrorSensors, inverterSensors, inverterErrorSensors,
} = require('../lib/sensor-definitions');

describe('sensor definitions', () => {
    // entity_category: 'config' means "user-configurable setting" in HA. Every
    // entry in `sensors` is a read-only value reported from the Kraken API, so
    // none of them should ever carry it — writable command entities (timezone
    // select, smart-charging switch) are defined separately in octopus-intelligent.js,
    // not in this array. Regression coverage for the mistake fixed in v1.3.0
    // (tariff codes), then again for Octoplus binary sensors, then again for the
    // v1.5.0 rate-band sensors (day/night/EV peak/off-peak), fixed in v1.6.1.
    test('no read-only sensor carries entity_category: config', () => {
        const offenders = sensors.filter(s => s.category === 'config').map(s => s.id);
        expect(offenders).toEqual([]);
    });

    test('every sensor has a unique id', () => {
        const ids = sensors.map(s => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('every error sensor has a unique id', () => {
        const ids = errorSensors.map(s => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    // v1.7.0 SmartFlex. Entity ids are frozen at first discovery in Home Assistant, so
    // these ids and names are pinned: renaming one later orphans existing entities.
    test('v1.7.0: SmartFlex vehicle sensors are defined with pinned ids, names and payload fields', () => {
        const byId = Object.fromEntries(vehicleSensors.map(s => [s.id, s]));
        const expected = {
            vehicle_make: ['Vehicle Make', 'vehicle_make', 'diagnostic'],
            vehicle_model: ['Vehicle Model', 'vehicle_model', 'diagnostic'],
            vehicle_battery_kwh: ['Vehicle Battery Size', 'vehicle_battery_kwh', 'diagnostic'],
            charger_power_kw: ['Charger Power', 'charger_power_kw', 'diagnostic'],
            vehicle_device_state: ['Vehicle Device State', 'device_state', 'diagnostic'],
            last_session_kwh: ['Last Charge Session Energy', 'last_session_kwh', undefined],
            last_session_soc_final: ['Last Charge Session Final Charge', 'last_session_soc_final', undefined],
            smartflex_vehicle_error: ['SmartFlex Vehicle Error', 'smartflex_vehicle_error', 'diagnostic'],
        };
        for (const [id, [name, val, category]] of Object.entries(expected)) {
            expect(byId[id]).toBeDefined();
            expect(byId[id].name).toBe(name);
            expect(byId[id].val).toBe(val);
            expect(byId[id].category).toBe(category);
        }
    });

    test('v1.7.0: Last Charge Session Energy is an energy total in kWh', () => {
        const s = vehicleSensors.find(v => v.id === 'last_session_kwh');
        expect(s).toMatchObject({ unit: 'kWh', class: 'energy', stateClass: 'total' });
    });

    // Review L5: a battery device_class would put the end-of-session charge into low-battery
    // alerts. It is a percentage with no device_class.
    test('v1.7.0: Last Charge Session Final Charge is a % measurement with no device_class', () => {
        const s = vehicleSensors.find(v => v.id === 'last_session_soc_final');
        expect(s.class).toBeUndefined();
        expect(s).toMatchObject({ unit: '%', stateClass: 'measurement', icon: 'mdi:battery-charging' });
    });

    test('v1.7.0: Vehicle Battery Size is energy_storage in kWh', () => {
        const s = vehicleSensors.find(v => v.id === 'vehicle_battery_kwh');
        expect(s).toMatchObject({ unit: 'kWh', class: 'energy_storage' });
    });

    test('v1.7.0: SmartFlex vehicle error has an error binary_sensor', () => {
        expect(vehicleErrorSensors).toEqual([
            { id: 'smartflex_vehicle_error_state', name: 'SmartFlex Vehicle Error State', val: 'smartflex_vehicle_error' },
        ]);
    });

    test('v1.7.0: vehicle sensors are kept separate so they are only announced when a vehicle is discovered', () => {
        const ids = vehicleSensors.map(s => s.id);
        expect(ids).toHaveLength(8);
        expect(sensors.some(s => ids.includes(s.id))).toBe(false);
        expect(errorSensors.some(e => e.id === 'smartflex_vehicle_error_state')).toBe(false);
    });

    test('v1.7.0: no vehicle sensor carries entity_category: config', () => {
        expect(vehicleSensors.filter(s => s.category === 'config').map(s => s.id)).toEqual([]);
    });

    test('v1.7.0: inverter sensors are kept separate so they are only announced when enabled', () => {
        const ids = inverterSensors.map(s => s.id);
        expect(ids).toEqual(expect.arrayContaining([
            'inverter_make', 'inverter_model', 'solar_peak_kw', 'inverter_power_kw',
            'inverter_connection_status', 'home_battery_power_kw', 'home_battery_soc',
            'solar_power_kw', 'grid_power_kw', 'site_consumption_kw', 'site_export_kw',
            'smartflex_inverter_error',
        ]));
        expect(sensors.some(s => ids.includes(s.id))).toBe(false);
        expect(inverterErrorSensors).toEqual([
            { id: 'smartflex_inverter_error_state', name: 'SmartFlex Inverter Error State', val: 'smartflex_inverter_error' },
        ]);
    });

    test('v1.7.0: no inverter sensor carries entity_category: config', () => {
        expect(inverterSensors.filter(s => s.category === 'config').map(s => s.id)).toEqual([]);
    });

    test('v1.7.0: sensor ids stay unique across main, vehicle and inverter sensors', () => {
        const ids = [...sensors, ...vehicleSensors, ...inverterSensors].map(s => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        const errIds = [...errorSensors, ...vehicleErrorSensors, ...inverterErrorSensors].map(s => s.id);
        expect(new Set(errIds).size).toBe(errIds.length);
    });
});
