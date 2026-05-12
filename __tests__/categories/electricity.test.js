// __tests__/categories/electricity.test.js
'use strict';
const electricity = require('../../lib/categories/electricity');
const {
    mockElectricityRatesResponse,
    mockElectricityConsumptionResponse
} = require('../../test-mocks');

describe('electricity category', () => {
    describe('buildRatesQuery', () => {
        test('returns query containing electricityAgreements', () => {
            const { query, variables } = electricity.buildRatesQuery('A-AAA-1234');
            expect(query).toContain('electricityAgreements');
            expect(variables.account).toBe('A-AAA-1234');
        });
    });

    describe('buildConsumptionQuery', () => {
        test('returns query containing electricity consumption fields', () => {
            const { query } = electricity.buildConsumptionQuery('A-AAA-1234');
            expect(query).toContain('consumption');
            expect(query).toContain('electricityMeterPoints');
        });
    });

    describe('parseRatesResponse', () => {
        test('extracts import tariff fields', () => {
            const result = electricity.parseRatesResponse(
                mockElectricityRatesResponse.data.data
            );
            expect(result.electricity_unit_rate).toBe(24.50);
            expect(result.electricity_standing_charge).toBe(53.37);
            expect(result.electricity_tariff_code).toBe('INTELLI-VAR-22-10-14');
            expect(result.electricity_valid_from).toBe('2024-10-01T00:00:00Z');
            expect(result.electricity_valid_to).toBeNull();
            expect(result.electricity_rates_error).toBeNull();
        });

        test('extracts export tariff fields when an OUTGOING agreement is present', () => {
            const result = electricity.parseRatesResponse(
                mockElectricityRatesResponse.data.data
            );
            expect(result.electricity_export_tariff_code).toBe('AGILE-OUTGOING-19-05-13');
            expect(result.electricity_export_standing_charge).toBe(0);
            expect(result.electricity_export_unit_rate).toBeNull();
            expect(result.electricity_export_valid_from).toBe('2024-09-01T00:00:00Z');
            expect(result.electricity_export_valid_to).toBeNull();
        });

        test('returns nulls for both import and export when no agreements', () => {
            const result = electricity.parseRatesResponse({ account: { electricityAgreements: [] } });
            expect(result.electricity_unit_rate).toBeNull();
            expect(result.electricity_tariff_code).toBeNull();
            expect(result.electricity_export_unit_rate).toBeNull();
            expect(result.electricity_export_tariff_code).toBeNull();
        });

        test('returns export nulls when account has only an import agreement', () => {
            const data = { account: { electricityAgreements: [{
                validFrom: '2024-10-01T00:00:00Z', validTo: null,
                tariff: { productCode: 'INTELLI-VAR-22-10-14', standingCharge: 50, unitRate: 20 }
            }] } };
            const result = electricity.parseRatesResponse(data);
            expect(result.electricity_tariff_code).toBe('INTELLI-VAR-22-10-14');
            expect(result.electricity_export_tariff_code).toBeNull();
            expect(result.electricity_export_standing_charge).toBeNull();
        });
    });

    describe('parseConsumptionResponse', () => {
        test('extracts import consumption for the matching MPAN', () => {
            const result = electricity.parseConsumptionResponse(
                mockElectricityConsumptionResponse.data.data,
                '1610000000001',
                null
            );
            expect(result.electricity_consumption_kwh).toBe(12.5);
            expect(result.electricity_consumption_from).toBe('2026-04-26T23:00:00Z');
            expect(result.electricity_consumption_to).toBe('2026-04-27T23:00:00Z');
            expect(result.electricity_consumption_error).toBeNull();
            expect(result.electricity_export_consumption_kwh).toBeNull();
        });

        test('extracts both import and export consumption when both MPANs provided', () => {
            const result = electricity.parseConsumptionResponse(
                mockElectricityConsumptionResponse.data.data,
                '1610000000001',
                '1650000000002'
            );
            expect(result.electricity_consumption_kwh).toBe(12.5);
            expect(result.electricity_export_consumption_kwh).toBe(4.2);
            expect(result.electricity_export_consumption_from).toBe('2026-04-26T23:00:00Z');
        });

        test('does not mix data when only the export MPAN is provided', () => {
            const result = electricity.parseConsumptionResponse(
                mockElectricityConsumptionResponse.data.data,
                null,
                '1650000000002'
            );
            expect(result.electricity_consumption_kwh).toBeNull();
            expect(result.electricity_export_consumption_kwh).toBe(4.2);
        });

        test('returns nulls when MPANs do not match any meter point', () => {
            const result = electricity.parseConsumptionResponse(
                mockElectricityConsumptionResponse.data.data,
                '9999999999999',
                '8888888888888'
            );
            expect(result.electricity_consumption_kwh).toBeNull();
            expect(result.electricity_export_consumption_kwh).toBeNull();
        });

        test('returns nulls when no meter points in response', () => {
            const result = electricity.parseConsumptionResponse(
                { account: { properties: [{ electricityMeterPoints: [] }] } },
                '1610000000001',
                '1650000000002'
            );
            expect(result.electricity_consumption_kwh).toBeNull();
            expect(result.electricity_export_consumption_kwh).toBeNull();
        });
    });

    describe('defaultData', () => {
        // Every field the parsers can emit must also be in defaultData,
        // otherwise the MQTT payload would drop that field on first run.
        test('defaultData covers every field that parseRatesResponse and parseConsumptionResponse can emit', () => {
            const ratesEmpty = Object.keys(electricity.parseRatesResponse({ account: { electricityAgreements: [] } }));
            const ratesPopulated = Object.keys(electricity.parseRatesResponse(mockElectricityRatesResponse.data.data));
            const consEmpty = Object.keys(electricity.parseConsumptionResponse(
                { account: { properties: [{ electricityMeterPoints: [] }] } }, null, null
            ));
            const consPopulated = Object.keys(electricity.parseConsumptionResponse(
                mockElectricityConsumptionResponse.data.data, '1610000000001', '1650000000002'
            ));
            for (const f of new Set([...ratesEmpty, ...ratesPopulated, ...consEmpty, ...consPopulated])) {
                expect(electricity.defaultData).toHaveProperty(f);
            }
        });
    });
});
