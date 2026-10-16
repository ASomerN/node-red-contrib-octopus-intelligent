// __tests__/categories/smartflex-inverter.test.js
'use strict';
const si = require('../../lib/categories/smartflex-inverter');

// NOT LIVE-VERIFIED. No account available to us has a SmartFlex inverter, so this
// fixture follows the introspected schema (6 Oct 2026), not a real response. Values are
// strings because Kraken sends Decimal fields as strings. Ids and account are fake.
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

const mockResponse = { devices: [{ __typename: 'SmartFlexVehicle', id: 'dev-1' }, inverter()] };

describe('smartflex-inverter category', () => {
    test('buildQuery asks for inverter details and telemetry', () => {
        const { query, variables } = si.buildQuery('A-FAKE0001');
        expect(variables).toEqual({ account: 'A-FAKE0001' });
        expect(query).toContain('devices(accountNumber: $account)');
        expect(query).toContain('... on SmartFlexInverter');
        expect(query).toContain('peakSolarPowerInKw');
        expect(query).toContain('telemetry');
        expect(query).toContain('stateOfCharge');
        expect(query).toContain('consumptionInKw');
        expect(query).not.toMatch(/getDevices|SmartFlexDevicePreferences|getDispatches/);
    });

    test('parseResponse extracts make, model and connection state', () => {
        const r = si.parseResponse(mockResponse, 'inv-1');
        expect(r.inverter_make).toBe('GivEnergy');
        expect(r.inverter_model).toBe('Gen 3');
        expect(r.inverter_connection_status).toBe('CONNECTED');
        expect(r.inverter_online).toBe(true);
        expect(r.smartflex_inverter_error).toBeNull();
    });

    test('parseResponse parses every string power and SoC field to a number', () => {
        const r = si.parseResponse(mockResponse, 'inv-1');
        expect(r.solar_peak_kw).toBe(4.2);
        expect(r.inverter_power_kw).toBe(2.5);
        expect(r.home_battery_power_kw).toBe(-1.2);
        expect(r.home_battery_soc).toBe(64);
        expect(r.solar_power_kw).toBe(3.1);
        expect(r.grid_power_kw).toBe(0.4);
        expect(r.site_consumption_kw).toBe(1.8);
        expect(r.site_export_kw).toBe(0);
    });

    test('inverter_online is false for any other connection status', () => {
        const inv = inverter();
        inv.telemetry.inverter.connectionStatus = 'DISCONNECTED';
        expect(si.parseResponse({ devices: [inv] }, 'inv-1').inverter_online).toBe(false);
    });

    test('inverter_online is null when connection status is missing', () => {
        const inv = inverter();
        inv.telemetry.inverter = null;
        const r = si.parseResponse({ devices: [inv] }, 'inv-1');
        expect(r.inverter_online).toBeNull();
        expect(r.inverter_power_kw).toBeNull();
    });

    test('takes the latest reading when telemetry arrives as a list', () => {
        const older = inverter().telemetry;
        const newer = { ...inverter().telemetry, solar: { powerInKw: '0.90' } };
        const r = si.parseResponse({ devices: [inverter({ telemetry: [older, newer] })] }, 'inv-1');
        expect(r.solar_power_kw).toBe(0.9);
    });

    test('handles null details and telemetry', () => {
        const r = si.parseResponse({ devices: [inverter({ details: null, telemetry: null })] }, 'inv-1');
        expect(r.inverter_make).toBe('GivEnergy');
        expect(r.solar_peak_kw).toBeNull();
        expect(r.home_battery_soc).toBeNull();
        expect(r.site_export_kw).toBeNull();
    });

    test('falls back to the first SmartFlexInverter when the id is not found', () => {
        const r = si.parseResponse(mockResponse, 'inv-unknown');
        expect(r.inverter_make).toBe('GivEnergy');
    });

    test('returns defaults when there is no inverter', () => {
        const r = si.parseResponse({ devices: [{ __typename: 'SmartFlexVehicle', id: 'dev-1' }] }, 'inv-1');
        expect(r).toEqual(si.defaultData);
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(si.parseResponse({}, 'inv-1'));
        const populatedKeys = Object.keys(si.parseResponse(mockResponse, 'inv-1'));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(si.defaultData).toHaveProperty(key);
        }
    });
});
