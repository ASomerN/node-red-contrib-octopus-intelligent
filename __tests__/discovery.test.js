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
