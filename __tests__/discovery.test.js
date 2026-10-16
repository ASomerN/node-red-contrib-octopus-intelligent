// __tests__/discovery.test.js
'use strict';
jest.mock('../lib/graphql');
jest.mock('../lib/auth');
const { graphqlPost } = require('../lib/graphql');
const { obtainToken } = require('../lib/auth');
const { discoverProducts, parseDiscovery } = require('../lib/discovery');

// Mirrors a live response observed 2026-05-11: export meter point appears
// at index 0 in the array, import at index 1. This is why discovery must
// select by `direction`, not position.
const mockDiscoveryResponse = {
    status: 200,
    data: {
        data: {
            account: {
                electricityAgreements: [{ validFrom: '2024-01-01' }],
                gasAgreements: [{ validFrom: '2024-01-01' }],
                properties: [{
                    electricityMeterPoints: [
                        { mpan: '1650000000002', direction: 'EXPORT', meters: [{ serialNumber: 'E001', smartImportElectricityMeter: null }] },
                        { mpan: '1610000000001', direction: 'IMPORT', meters: [{ serialNumber: 'E001', smartImportElectricityMeter: { deviceId: 'AA-BB-CC-00-00-01-02-03' } }] }
                    ],
                    gasMeterPoints: [{ mprn: '9876543210', meters: [{ serialNumber: 'G001' }] }]
                }]
            },
            devices: [
                { id: 'device-abc', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: false } }
            ]
        }
    }
};

describe('parseDiscovery', () => {
    test('detects electricity, gas, intelligent device, and smart meter', () => {
        const result = parseDiscovery(mockDiscoveryResponse.data.data);
        expect(result.hasIntelligent).toBe(true);
        expect(result.hasElectricity).toBe(true);
        expect(result.hasGas).toBe(true);
        expect(result.deviceId).toBe('device-abc');
        expect(result.deviceSuspended).toBe(false);
        expect(result.smartMeterDeviceId).toBe('AA-BB-CC-00-00-01-02-03');
        expect(result.gasMprn).toBe('9876543210');
        expect(result.gasSerial).toBe('G001');
    });

    test('picks import and export MPANs by direction, not array position', () => {
        const result = parseDiscovery(mockDiscoveryResponse.data.data);
        expect(result.electricityMpan).toBe('1610000000001');
        expect(result.electricityExportMpan).toBe('1650000000002');
        expect(result.electricitySerial).toBe('E001'); // serial from the import meter point
    });

    test('electricityExportMpan is null when account has no export meter point', () => {
        const data = {
            ...mockDiscoveryResponse.data.data,
            account: {
                ...mockDiscoveryResponse.data.data.account,
                properties: [{
                    electricityMeterPoints: [
                        { mpan: '1610000000001', direction: 'IMPORT', meters: [{ serialNumber: 'E001', smartImportElectricityMeter: null }] }
                    ],
                    gasMeterPoints: []
                }]
            }
        };
        const result = parseDiscovery(data);
        expect(result.electricityMpan).toBe('1610000000001');
        expect(result.electricityExportMpan).toBeNull();
    });

    test('electricityMpan is null when account has only an export meter point', () => {
        const data = {
            ...mockDiscoveryResponse.data.data,
            account: {
                ...mockDiscoveryResponse.data.data.account,
                properties: [{
                    electricityMeterPoints: [
                        { mpan: '1650000000002', direction: 'EXPORT', meters: [{ serialNumber: 'E001', smartImportElectricityMeter: null }] }
                    ],
                    gasMeterPoints: []
                }]
            }
        };
        const result = parseDiscovery(data);
        expect(result.electricityMpan).toBeNull();
        expect(result.electricityExportMpan).toBe('1650000000002');
    });

    test('smartMeterDeviceId is null when no smartImportElectricityMeter on any meter', () => {
        const data = {
            ...mockDiscoveryResponse.data.data,
            account: {
                ...mockDiscoveryResponse.data.data.account,
                properties: [{
                    electricityMeterPoints: [
                        { mpan: '1610000000001', direction: 'IMPORT', meters: [{ serialNumber: 'E001', smartImportElectricityMeter: null }] }
                    ],
                    gasMeterPoints: []
                }]
            }
        };
        expect(parseDiscovery(data).smartMeterDeviceId).toBeNull();
    });

    test('hasIntelligent false when no EV device in devices list', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [] };
        const result = parseDiscovery(data);
        expect(result.hasIntelligent).toBe(false);
        expect(result.deviceId).toBeNull();
    });

    // v1.7.0: SmartFlex vehicle / charge point and inverter detection.
    test('vehicleDeviceId comes from the ELECTRIC_VEHICLES device', () => {
        const result = parseDiscovery(mockDiscoveryResponse.data.data);
        expect(result.vehicleDeviceId).toBe('device-abc');
        expect(result.inverterDeviceId).toBeNull();
    });

    // Kraken's KrakenFlexDeviceTypes enum has no CHARGE_POINTS value (introspection): a charge
    // point (SmartFlexChargePoint) is listed as ELECTRIC_VEHICLES. It is the device Octopus
    // smart-charges, so it gets the charging poll, the Boost switch and the vehicle entities.
    test('a charge point arrives as ELECTRIC_VEHICLES and is used like a car', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [
            { id: 'cp-1', __typename: 'SmartFlexChargePoint', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: false } },
        ] };
        const result = parseDiscovery(data);
        expect(result.hasIntelligent).toBe(true);
        expect(result.deviceId).toBe('cp-1');
        expect(result.vehicleDeviceId).toBe('cp-1');
    });

    test('deviceType decides: a vehicle __typename without ELECTRIC_VEHICLES is not used', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [
            { id: 'odd-1', __typename: 'SmartFlexChargePoint', deviceType: 'BATTERIES', status: { isSuspended: false } },
        ] };
        const result = parseDiscovery(data);
        expect(result.hasIntelligent).toBe(false);
        expect(result.deviceId).toBeNull();
        expect(result.vehicleDeviceId).toBeNull();
    });

    test('vehicleDeviceId is null when there is no vehicle or charge point', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [] };
        expect(parseDiscovery(data).vehicleDeviceId).toBeNull();
    });

    test('inverterDeviceId detects a SmartFlexInverter by __typename', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [
            { id: 'dev-1', __typename: 'SmartFlexVehicle', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: false } },
            { id: 'inv-1', __typename: 'SmartFlexInverter', deviceType: 'BATTERIES', status: { isSuspended: false } },
        ] };
        const result = parseDiscovery(data);
        expect(result.inverterDeviceId).toBe('inv-1');
        expect(result.vehicleDeviceId).toBe('dev-1');
    });

    test('the vehicle entities and boost always describe the same device', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [
            { id: 'inv-1', __typename: 'SmartFlexInverter', deviceType: 'INVERTERS', status: { isSuspended: false } },
            { id: 'cp-9', __typename: 'SmartFlexChargePoint', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: false } },
            { id: 'dev-1', __typename: 'SmartFlexVehicle', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: false } },
        ] };
        const result = parseDiscovery(data);
        expect(result.deviceId).toBe('cp-9');
        expect(result.vehicleDeviceId).toBe(result.deviceId);
    });

    // Review L4: Kraken can list a replaced (RETIRED) car first. The LIVE device is the one
    // Octopus smart-charges, so it is picked; the first EV is the fallback.
    test('prefers the LIVE EV over a RETIRED one listed first', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [
            { id: 'old-car', __typename: 'SmartFlexVehicle', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: false, current: 'RETIRED' } },
            { id: 'new-car', __typename: 'SmartFlexVehicle', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: true, current: 'LIVE' } },
        ] };
        const result = parseDiscovery(data);
        expect(result.deviceId).toBe('new-car');
        expect(result.vehicleDeviceId).toBe('new-car');
        expect(result.deviceSuspended).toBe(true);
    });

    test('falls back to the first EV when none is LIVE', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [
            { id: 'ev-a', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: false, current: 'ONBOARDING' } },
            { id: 'ev-b', deviceType: 'ELECTRIC_VEHICLES', status: null },
        ] };
        const result = parseDiscovery(data);
        expect(result.deviceId).toBe('ev-a');
        expect(result.vehicleDeviceId).toBe('ev-a');
    });

    test('a LIVE device of another type is never picked as the EV', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [
            { id: 'ev-a', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: false, current: 'PENDING_LIVE' } },
            { id: 'hp-1', deviceType: 'HEAT_PUMPS', status: { isSuspended: false, current: 'LIVE' } },
        ] };
        expect(parseDiscovery(data).deviceId).toBe('ev-a');
    });

    test('deviceCount counts the listed devices (0 for an empty or missing list)', () => {
        expect(parseDiscovery(mockDiscoveryResponse.data.data).deviceCount).toBe(1);
        expect(parseDiscovery({ ...mockDiscoveryResponse.data.data, devices: [] }).deviceCount).toBe(0);
        expect(parseDiscovery({ ...mockDiscoveryResponse.data.data, devices: null }).deviceCount).toBe(0);
        expect(parseDiscovery({ ...mockDiscoveryResponse.data.data, devices: [null] }).deviceCount).toBe(0);
    });

    test('a null entry in the device list does not break discovery', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [null,
            { id: 'dev-1', __typename: 'SmartFlexVehicle', deviceType: 'ELECTRIC_VEHICLES', status: { isSuspended: false } },
        ] };
        const result = parseDiscovery(data);
        expect(result.deviceId).toBe('dev-1');
        expect(result.vehicleDeviceId).toBe('dev-1');
    });

    test('inverterDeviceId detects an inverter by deviceType when __typename is absent', () => {
        const data = { ...mockDiscoveryResponse.data.data, devices: [
            { id: 'inv-2', deviceType: 'SOLAR_INVERTERS', status: null },
        ] };
        const result = parseDiscovery(data);
        expect(result.inverterDeviceId).toBe('inv-2');
        expect(result.hasIntelligent).toBe(false);
    });

    test('hasElectricity false when no electricity agreements', () => {
        const data = {
            ...mockDiscoveryResponse.data.data,
            account: { ...mockDiscoveryResponse.data.data.account, electricityAgreements: [] }
        };
        expect(parseDiscovery(data).hasElectricity).toBe(false);
    });

    test('hasGas false when no gas agreements', () => {
        const data = {
            ...mockDiscoveryResponse.data.data,
            account: { ...mockDiscoveryResponse.data.data.account, gasAgreements: [] }
        };
        expect(parseDiscovery(data).hasGas).toBe(false);
    });
});

describe('discoverProducts', () => {
    beforeEach(() => {
        obtainToken.mockResolvedValue('fake-token');
        graphqlPost.mockResolvedValue(mockDiscoveryResponse);
    });

    // Live shape observed 2026-09-29 (KT-CT-4360 on devices[0].status)
    const partialStatusError = (devices) => ({
        data: {
            data: { ...mockDiscoveryResponse.data.data, devices },
            errors: [{
                message: 'Device status could not be fetched.',
                path: ['devices', 0, 'status'],
                extensions: { errorType: 'APPLICATION', errorCode: 'KT-CT-4360' },
            }],
        },
    });

    test('tolerates a partial error on devices[n].status (suspended unknown)', async () => {
        graphqlPost.mockResolvedValue(partialStatusError([{ id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES', status: null }]));
        const r = await discoverProducts('key', 'acc');
        expect(r.hasIntelligent).toBe(true);
        expect(r.deviceId).toBe('dev-1');
        expect(r.deviceSuspended).toBeNull();
    });

    test('still throws when any error is outside devices[n].status', async () => {
        const resp = partialStatusError([{ id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES', status: null }]);
        resp.data.errors.push({ message: 'boom', path: ['account'] });
        graphqlPost.mockResolvedValue(resp);
        await expect(discoverProducts('key', 'acc')).rejects.toThrow('Discovery failed');
    });

    test('still throws on a status error when devices data is missing', async () => {
        const resp = partialStatusError(undefined);
        delete resp.data.data.devices;
        graphqlPost.mockResolvedValue(resp);
        await expect(discoverProducts('key', 'acc')).rejects.toThrow('Discovery failed');
    });

    test('reads the device lifecycle status (status.current) in the same status selection', async () => {
        await discoverProducts('api-key', 'A-AAA-1234');
        const { query } = graphqlPost.mock.calls[0][0];
        expect(query).toMatch(/status\s*\{\s*isSuspended\s+current\s*\}/);
        expect(query.match(/status\s*\{/g)).toHaveLength(1);
    });

    // Second-eyes review D: status is non-null inside a non-null list, so a KT-CT-4360 on it nulls
    // `devices`. Discovery then threw, and NOTHING polled while it lasted.
    test('a status error that nulls the device list: asks again without the status and finds the car', async () => {
        const nulled = partialStatusError(null);
        const noStatus = { data: { data: { devices: [{ __typename: 'SmartFlexVehicle', id: 'dev-1', deviceType: 'ELECTRIC_VEHICLES' }] } } };
        graphqlPost.mockReset();
        graphqlPost.mockResolvedValueOnce(nulled).mockResolvedValueOnce(noStatus);
        const r = await discoverProducts('key', 'acc');
        expect(graphqlPost).toHaveBeenCalledTimes(2);
        const second = graphqlPost.mock.calls[1][0];
        expect(second.query).toMatch(/devices\(accountNumber: \$account\)\s*\{\s*__typename\s+id\s+deviceType\s*\}/);
        expect(second.query).not.toMatch(/status/);
        expect(second.variables).toEqual({ account: 'acc' });
        expect(graphqlPost.mock.calls[1][1]).toBe('fake-token');
        expect(r).toEqual(expect.objectContaining({
            hasIntelligent: true, deviceId: 'dev-1', deviceSuspended: null, deviceCount: 1,
            hasElectricity: true, hasGas: true, electricityMpan: '1610000000001', statusErrorCode: 'KT-CT-4360',
        }));
    });

    test('if the ask without the status fails too, discovery fails as before', async () => {
        graphqlPost.mockReset();
        graphqlPost.mockResolvedValueOnce(partialStatusError(null))
            .mockResolvedValueOnce({ data: { data: null, errors: [{ message: 'still down', extensions: { errorCode: 'KT-CT-9999' } }] } });
        await expect(discoverProducts('key', 'acc')).rejects.toThrow(/Discovery failed: .*KT-CT-9999/);
        expect(graphqlPost).toHaveBeenCalledTimes(2);
    });

    test('a plain answer asks once and carries no statusErrorCode', async () => {
        graphqlPost.mockClear();
        const r = await discoverProducts('key', 'acc');
        expect(graphqlPost).toHaveBeenCalledTimes(1);
        expect(r).not.toHaveProperty('statusErrorCode');
    });

    // Network sweep F4: a token answer after the node closed must not send the discover query.
    test('stops with "Node closed" and sends no query once isClosed is true', async () => {
        graphqlPost.mockClear();
        let closed = false;
        obtainToken.mockImplementationOnce(async () => { closed = true; return 'fake-token'; });
        await expect(discoverProducts('key', 'acc', { isClosed: () => closed })).rejects.toThrow('Node closed');
        expect(graphqlPost).not.toHaveBeenCalled();
    });

    test('calls obtainToken then graphqlPost', async () => {
        await discoverProducts('api-key', 'A-AAA-1234');
        expect(obtainToken).toHaveBeenCalledWith('api-key');
        expect(graphqlPost).toHaveBeenCalledWith(
            expect.objectContaining({ variables: { account: 'A-AAA-1234' } }),
            'fake-token'
        );
    });

    test('throws when discovery query returns errors', async () => {
        graphqlPost.mockResolvedValue({ data: { errors: [{ message: 'fail' }] } });
        await expect(discoverProducts('key', 'acc')).rejects.toThrow('Discovery failed');
    });

    test('throws when response data is missing', async () => {
        graphqlPost.mockResolvedValue({ data: {} });
        await expect(discoverProducts('key', 'acc')).rejects.toThrow('Discovery response missing data');
    });
});

// Adversarial review A12: Kraken can echo request variables in an error message.
describe('discoverProducts error text keeps the key and token Octopus echoed', () => {
    beforeEach(() => {
        obtainToken.mockResolvedValue('fake-token');
    });

    test('an API key or JWT in a discovery error is shown as it is', async () => {
        const key = 'sk_live_AbCdEf0123456789ZyXw';
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzNDU2In0.c2lnbmF0dXJlLXZhbHVl';
        graphqlPost.mockResolvedValue({ status: 200, data: { errors: [{ message: `Bad input {'APIKey': '${key}'} ${jwt}`, path: ['account'] }] } });
        const err = await discoverProducts('key', 'acc').catch((e) => e);
        expect(err.message).toMatch(/^Discovery failed/);
        expect(err.message).toContain(key);
        expect(err.message).toContain(jwt);
    });
});

// Sweep 2026-10-08 #7: the node retries discovery when the device list comes back empty.
describe('parseDiscovery deviceCount (1.6.2)', () => {
    test('counts the devices Kraken returned', () => {
        expect(parseDiscovery(mockDiscoveryResponse.data.data).deviceCount).toBe(mockDiscoveryResponse.data.data.devices.length);
        expect(parseDiscovery({ ...mockDiscoveryResponse.data.data, devices: [] }).deviceCount).toBe(0);
    });
    test('a missing or null device list counts as 0', () => {
        expect(parseDiscovery({ ...mockDiscoveryResponse.data.data, devices: null }).deviceCount).toBe(0);
        const { devices, ...noDevices } = mockDiscoveryResponse.data.data;
        expect(devices).toBeDefined();
        expect(parseDiscovery(noDevices).deviceCount).toBe(0);
    });
});
