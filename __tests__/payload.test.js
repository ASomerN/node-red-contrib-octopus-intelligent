// __tests__/payload.test.js
'use strict';
const { mergePayload, buildDefaultPayload } = require('../lib/payload');

describe('mergePayload', () => {
    test('merges category data into base state', () => {
        const base = { next_start: '2025-01-01', electricity_unit_rate: null };
        const newData = { electricity_unit_rate: 28.5 };
        const result = mergePayload(base, newData);
        expect(result.next_start).toBe('2025-01-01');
        expect(result.electricity_unit_rate).toBe(28.5);
    });

    test('does not mutate base object', () => {
        const base = { a: 1 };
        mergePayload(base, { b: 2 });
        expect(base).toEqual({ a: 1 });
    });
});

describe('buildDefaultPayload', () => {
    test('includes all V1 fields with null/zero defaults', () => {
        const state = {
            confirmedLimit: 80, confirmedTime: '08:00',
            pendingLimit: 80, pendingTime: '08:00',
            chargingNow: false, smartChargingSuspended: false
        };
        const payload = buildDefaultPayload(state);
        expect(payload.next_start).toBeNull();
        expect(payload.total_energy).toBe(0);
        expect(payload.confirmed_limit).toBe(80);
        expect(payload.charging_now).toBe(false);
        expect(payload.smart_charging).toBe(true);
    });

    test('smart_charging is null when suspended state unknown', () => {
        const state = {
            confirmedLimit: 80, confirmedTime: '08:00',
            pendingLimit: 80, pendingTime: '08:00',
            chargingNow: false, smartChargingSuspended: null
        };
        expect(buildDefaultPayload(state).smart_charging).toBeNull();
    });

    test('includes new V2 fields with null defaults', () => {
        const state = {
            confirmedLimit: 80, confirmedTime: '08:00',
            pendingLimit: 80, pendingTime: '08:00',
            chargingNow: false, smartChargingSuspended: null
        };
        const payload = buildDefaultPayload(state);
        expect(payload).toHaveProperty('electricity_unit_rate', null);
        expect(payload).toHaveProperty('electricity_rates_error', null);
        expect(payload).toHaveProperty('electricity_consumption_error', null);
        expect(payload).toHaveProperty('gas_unit_rate', null);
        expect(payload).toHaveProperty('gas_rates_error', null);
        expect(payload).toHaveProperty('gas_consumption_error', null);
        expect(payload).toHaveProperty('wheel_of_fortune_electricity_spins', null);
        expect(payload).toHaveProperty('wheel_of_fortune_electricity_max', null);
        expect(payload).toHaveProperty('wheel_of_fortune_error', null);
        expect(payload).toHaveProperty('mini_demand_kw', null);
        expect(payload).toHaveProperty('mini_consumption_delta_kwh', null);
        expect(payload).toHaveProperty('mini_read_at', null);
        expect(payload).toHaveProperty('home_mini_error', null);
        expect(payload).toHaveProperty('saving_session_available', null);
        expect(payload).toHaveProperty('saving_session_points', null);
        expect(payload).toHaveProperty('saving_sessions_error', null);
        expect(payload).toHaveProperty('intelligent_error', null);
        expect(payload).toHaveProperty('free_electricity_active', null);
        expect(payload).toHaveProperty('free_electricity_available', null);
        expect(payload).toHaveProperty('free_electricity_start', null);
        expect(payload).toHaveProperty('free_electricity_end', null);
        expect(payload).toHaveProperty('free_electricity_error', null);
    });

    test('throws TypeError when state is not an object', () => {
        expect(() => buildDefaultPayload(undefined)).toThrow(TypeError);
        expect(() => buildDefaultPayload(null)).toThrow(TypeError);
    });
});
