// __tests__/categories/applicable-rates.test.js
'use strict';
const ar = require('../../lib/categories/applicable-rates');

// Use a fixed "now" so the current-rate detection is deterministic
const NOW = new Date('2026-04-30T14:15:00Z');

const mockResponse = {
    applicableRates: {
        edges: [
            { node: { validFrom: '2026-04-30T14:00:00Z', validTo: '2026-04-30T14:30:00Z', value: '7.25000' } },
            { node: { validFrom: '2026-04-30T14:30:00Z', validTo: '2026-04-30T15:00:00Z', value: '0.00000' } },
            { node: { validFrom: '2026-04-30T15:00:00Z', validTo: '2026-04-30T15:30:00Z', value: '0.00000' } }
        ]
    }
};

describe('applicable-rates category', () => {
    test('buildQuery includes account, mpxn, startAt and endAt', () => {
        const { query, variables } = ar.buildQuery('A-TEST-1234', '1234567890123');
        expect(query).toContain('applicableRates');
        expect(query).toContain('$mpxn');
        expect(variables.account).toBe('A-TEST-1234');
        expect(variables.mpxn).toBe('1234567890123');
        expect(variables.startAt).toBeTruthy();
        expect(variables.endAt).toBeTruthy();
    });

    test('endAt is 24h after startAt', () => {
        const { variables } = ar.buildQuery('A-TEST', '1234567890123');
        const diff = new Date(variables.endAt) - new Date(variables.startAt);
        expect(diff).toBeCloseTo(24 * 60 * 60 * 1000, -3);
    });

    test('parseResponse extracts rate slots', () => {
        const result = ar.parseResponse(mockResponse);
        expect(result.applicable_rates_count).toBe(3);
        expect(result.applicable_rates[0].value_pence_per_kwh).toBe(7.25);
        expect(result.applicable_rates[0].valid_from).toBe('2026-04-30T14:00:00Z');
        expect(result.applicable_rates_error).toBeNull();
    });

    test('parseResponse identifies current rate slot in pence and GBP', () => {
        jest.useFakeTimers().setSystemTime(NOW);
        const result = ar.parseResponse(mockResponse);
        expect(result.applicable_rates_current_pence).toBe(7.25);
        expect(result.applicable_rates_current_gbp).toBe(0.0725);
        jest.useRealTimers();
    });

    test('applicable_rates_current_gbp has 4dp precision', () => {
        jest.useFakeTimers().setSystemTime(NOW);
        const data = { applicableRates: { edges: [
            { node: { validFrom: '2026-04-30T14:00:00Z', validTo: '2026-04-30T14:30:00Z', value: '24.42500' } }
        ] } };
        const result = ar.parseResponse(data);
        expect(result.applicable_rates_current_gbp).toBe(0.2442); // 24.425 / 100 — floating point rounds to 0.2442
        jest.useRealTimers();
    });

    test('fieldPrefix option swaps output naming for export use', () => {
        jest.useFakeTimers().setSystemTime(NOW);
        const result = ar.parseResponse(mockResponse, { fieldPrefix: 'electricity_export_rate' });
        // Import-prefixed keys must not appear when a custom prefix is used
        expect(result.applicable_rates_current_pence).toBeUndefined();
        expect(result.applicable_rates).toBeUndefined();
        // Export-prefixed keys carry the same values
        expect(result.electricity_export_rate_count).toBe(3);
        expect(result.electricity_export_rate_current_pence).toBe(7.25);
        expect(result.electricity_export_rate_current_gbp).toBe(0.0725);
        expect(result.electricity_export_rate[0].value_pence_per_kwh).toBe(7.25);
        expect(result.electricity_export_rate_error).toBeNull();
        jest.useRealTimers();
    });

    test('parseResponse returns null for both rate fields when no slot matches now', () => {
        const result = ar.parseResponse({ applicableRates: { edges: [] } });
        expect(result.applicable_rates_current_pence).toBeNull();
        expect(result.applicable_rates_current_gbp).toBeNull();
        expect(result.applicable_rates_count).toBe(0);
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(ar.parseResponse({ applicableRates: { edges: [] } }));
        const populatedKeys = Object.keys(ar.parseResponse(mockResponse));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(ar.defaultData).toHaveProperty(key);
        }
    });

    test('parseResponse: next slot populated, prev null when current is first slot', () => {
        // NOW = 14:15 → slot 0 (14:00-14:30) is current → no prev, next is slot 1
        jest.useFakeTimers().setSystemTime(new Date('2026-04-30T14:15:00Z'));
        const result = ar.parseResponse(mockResponse);
        expect(result.applicable_rates_prev_pence).toBeNull();
        expect(result.applicable_rates_prev_gbp).toBeNull();
        expect(result.applicable_rates_prev_to).toBeNull();
        expect(result.applicable_rates_next_pence).toBe(0);
        expect(result.applicable_rates_next_gbp).toBe(0);
        expect(result.applicable_rates_next_from).toBe('2026-04-30T14:30:00Z');
        jest.useRealTimers();
    });

    test('parseResponse: both prev and next populated when current is middle slot', () => {
        // NOW = 14:45 → slot 1 (14:30-15:00) is current → prev is slot 0, next is slot 2
        jest.useFakeTimers().setSystemTime(new Date('2026-04-30T14:45:00Z'));
        const result = ar.parseResponse(mockResponse);
        expect(result.applicable_rates_prev_pence).toBe(7.25);
        expect(result.applicable_rates_prev_gbp).toBe(0.0725);
        expect(result.applicable_rates_prev_to).toBe('2026-04-30T14:30:00Z');
        expect(result.applicable_rates_next_pence).toBe(0);
        expect(result.applicable_rates_next_gbp).toBe(0);
        expect(result.applicable_rates_next_from).toBe('2026-04-30T15:00:00Z');
        jest.useRealTimers();
    });

    test('parseResponse: prev populated, next null when current is last slot', () => {
        // NOW = 15:15 → slot 2 (15:00-15:30) is current → prev is slot 1, no next
        jest.useFakeTimers().setSystemTime(new Date('2026-04-30T15:15:00Z'));
        const result = ar.parseResponse(mockResponse);
        expect(result.applicable_rates_prev_pence).toBe(0);
        expect(result.applicable_rates_prev_gbp).toBe(0);
        expect(result.applicable_rates_prev_to).toBe('2026-04-30T15:00:00Z');
        expect(result.applicable_rates_next_pence).toBeNull();
        expect(result.applicable_rates_next_gbp).toBeNull();
        expect(result.applicable_rates_next_from).toBeNull();
        jest.useRealTimers();
    });

    test('parseResponse: prev and next all null when no slot matches now', () => {
        const result = ar.parseResponse({ applicableRates: { edges: [] } });
        expect(result.applicable_rates_prev_pence).toBeNull();
        expect(result.applicable_rates_prev_gbp).toBeNull();
        expect(result.applicable_rates_prev_to).toBeNull();
        expect(result.applicable_rates_next_pence).toBeNull();
        expect(result.applicable_rates_next_gbp).toBeNull();
        expect(result.applicable_rates_next_from).toBeNull();
    });

});

describe('applicable-rates stats (v1.5)', () => {
    const { parseResponse } = require('../../lib/categories/applicable-rates');
    function edge(from, to, value) {
        return { node: { validFrom: from, validTo: to, value: String(value) } };
    }
    it('computes min/max/median/avg over a 4-slot schedule (even-N median)', () => {
        const data = { applicableRates: { edges: [
            edge('2026-06-01T00:00:00Z', '2026-06-01T00:30:00Z', 10),
            edge('2026-06-01T00:30:00Z', '2026-06-01T01:00:00Z', 20),
            edge('2026-06-01T01:00:00Z', '2026-06-01T01:30:00Z', 30),
            edge('2026-06-01T01:30:00Z', '2026-06-01T02:00:00Z', 40),
        ] } };
        const r = parseResponse(data);
        expect(r.applicable_rates_min_pence).toBe(10);
        expect(r.applicable_rates_max_pence).toBe(40);
        expect(r.applicable_rates_median_pence).toBe(25); // (20+30)/2
        expect(r.applicable_rates_avg_pence).toBe(25);
    });
    it('odd-N median picks the middle value', () => {
        const data = { applicableRates: { edges: [
            edge('2026-06-01T00:00:00Z', '2026-06-01T00:30:00Z', 5),
            edge('2026-06-01T00:30:00Z', '2026-06-01T01:00:00Z', 15),
            edge('2026-06-01T01:00:00Z', '2026-06-01T01:30:00Z', 25),
        ] } };
        const r = parseResponse(data);
        expect(r.applicable_rates_median_pence).toBe(15);
    });
    it('all-null schedule → all stats null', () => {
        const data = { applicableRates: { edges: [
            { node: { validFrom: '2026-06-01T00:00:00Z', validTo: '2026-06-01T00:30:00Z', value: null } },
            { node: { validFrom: '2026-06-01T00:30:00Z', validTo: '2026-06-01T01:00:00Z', value: null } },
        ] } };
        const r = parseResponse(data);
        expect(r.applicable_rates_min_pence).toBeNull();
        expect(r.applicable_rates_max_pence).toBeNull();
        expect(r.applicable_rates_median_pence).toBeNull();
        expect(r.applicable_rates_avg_pence).toBeNull();
    });
    it('empty schedule → all stats null', () => {
        const r = parseResponse({ applicableRates: { edges: [] } });
        expect(r.applicable_rates_min_pence).toBeNull();
    });
    it('single-slot schedule → min=max=median=avg', () => {
        const data = { applicableRates: { edges: [
            edge('2026-06-01T00:00:00Z', '2026-06-01T00:30:00Z', 15.5),
        ] } };
        const r = parseResponse(data);
        expect(r.applicable_rates_min_pence).toBe(15.5);
        expect(r.applicable_rates_max_pence).toBe(15.5);
        expect(r.applicable_rates_median_pence).toBe(15.5);
        expect(r.applicable_rates_avg_pence).toBe(15.5);
    });
    it('emits export-side stats under fieldPrefix', () => {
        const data = { applicableRates: { edges: [
            edge('2026-06-01T00:00:00Z', '2026-06-01T00:30:00Z', 12),
            edge('2026-06-01T00:30:00Z', '2026-06-01T01:00:00Z', 18),
        ] } };
        const r = parseResponse(data, { fieldPrefix: 'electricity_export_rate' });
        expect(r.electricity_export_rate_min_pence).toBe(12);
        expect(r.electricity_export_rate_max_pence).toBe(18);
        expect(r.electricity_export_rate_median_pence).toBe(15);
        expect(r.electricity_export_rate_avg_pence).toBe(15);
    });
});
