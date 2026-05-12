// __tests__/categories/gas.test.js
'use strict';
const gas = require('../../lib/categories/gas');
const { mockGasRatesResponse, mockGasConsumptionResponse } = require('../../test-mocks');

describe('gas category', () => {
    test('buildRatesQuery includes gasAgreements', () => {
        const { query } = gas.buildRatesQuery('A-AAA-1234');
        expect(query).toContain('gasAgreements');
    });

    test('parseRatesResponse extracts gas unit rate and standing charge', () => {
        const result = gas.parseRatesResponse(mockGasRatesResponse.data.data);
        expect(result.gas_unit_rate).toBe(6.24);
        expect(result.gas_standing_charge).toBe(29.50);
        expect(result.gas_tariff_code).toBe('VAR-22-11-01');
        expect(result.gas_rates_error).toBeNull();
    });

    test('parseConsumptionResponse extracts gas consumption', () => {
        const result = gas.parseConsumptionResponse(mockGasConsumptionResponse.data.data);
        expect(result.gas_consumption_kwh).toBe(8.3);
        expect(result.gas_consumption_from).toBe('2026-04-26T23:00:00Z');
        expect(result.gas_consumption_error).toBeNull();
    });

    test('defaultData covers every field that parseRatesResponse and parseConsumptionResponse can emit', () => {
        const ratesKeys = Object.keys(gas.parseRatesResponse({ account: { gasAgreements: [] } }));
        const ratesPopulatedKeys = Object.keys(gas.parseRatesResponse(mockGasRatesResponse.data.data));
        const consumptionKeys = Object.keys(gas.parseConsumptionResponse({ account: { properties: [] } }));
        const consumptionPopulatedKeys = Object.keys(gas.parseConsumptionResponse(mockGasConsumptionResponse.data.data));
        for (const key of new Set([...ratesKeys, ...ratesPopulatedKeys, ...consumptionKeys, ...consumptionPopulatedKeys])) {
            expect(gas.defaultData).toHaveProperty(key);
        }
    });
});
