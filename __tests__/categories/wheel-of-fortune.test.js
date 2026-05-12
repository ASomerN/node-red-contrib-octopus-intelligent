'use strict';
const wof = require('../../lib/categories/wheel-of-fortune');
const { mockWheelOfFortuneResponse } = require('../../test-mocks');

describe('wheel-of-fortune category', () => {
    test('buildQuery uses wheelOfFortuneSpinsAllowed on the backend endpoint', () => {
        const { query, variables, hostname } = wof.buildQuery('A-AAA-1234');
        expect(query).toContain('wheelOfFortuneSpinsAllowed');
        expect(query).not.toMatch(/wheelOfFortuneSpins\(/);
        expect(variables.accountNumber).toBe('A-AAA-1234');
        expect(hostname).toBe('api.backend.octopus.energy');
    });

    test('parseResponse extracts spinsAllowed per fuel type', () => {
        const result = wof.parseResponse(mockWheelOfFortuneResponse.data.data);
        expect(result.wheel_of_fortune_electricity_spins).toBe(2);
        expect(result.wheel_of_fortune_gas_spins).toBe(0);
        expect(result.wheel_of_fortune_error).toBeNull();
    });

    test('parseResponse returns null for max/used (not in new API)', () => {
        const result = wof.parseResponse(mockWheelOfFortuneResponse.data.data);
        expect(result.wheel_of_fortune_electricity_max).toBeNull();
        expect(result.wheel_of_fortune_electricity_used).toBeNull();
        expect(result.wheel_of_fortune_gas_max).toBeNull();
        expect(result.wheel_of_fortune_gas_used).toBeNull();
    });

    test('parseResponse returns zero spins when data absent', () => {
        const result = wof.parseResponse({});
        expect(result.wheel_of_fortune_electricity_spins).toBe(0);
        expect(result.wheel_of_fortune_gas_spins).toBe(0);
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(wof.parseResponse({}));
        const populatedKeys = Object.keys(wof.parseResponse(mockWheelOfFortuneResponse.data.data));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(wof.defaultData).toHaveProperty(key);
        }
    });
});
