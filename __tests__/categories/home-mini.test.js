'use strict';
const mini = require('../../lib/categories/home-mini');

describe('home-mini category', () => {
    test('buildQuery includes smartMeterTelemetry and deviceId variable', () => {
        const { query, variables } = mini.buildQuery('device-sm-123');
        expect(query).toContain('smartMeterTelemetry');
        expect(query).toContain('$deviceId');
        expect(query).toContain('HALF_HOURLY');
        expect(variables.deviceId).toBe('device-sm-123');
        expect(variables.start).toBeDefined();
        expect(variables.end).toBeDefined();
    });

    test('parseResponse converts demand W→kW and consumptionDelta Wh→kWh', () => {
        const data = {
            smartMeterTelemetry: [
                { readAt: '2026-04-30T10:00:00Z', demand: '-500', consumptionDelta: '100' },
                { readAt: '2026-04-30T10:30:00Z', demand: '-983', consumptionDelta: '2' }
            ]
        };
        const result = mini.parseResponse(data);
        expect(result.mini_demand_kw).toBeCloseTo(-0.983);
        expect(result.mini_consumption_delta_kwh).toBeCloseTo(0.002);
        expect(result.mini_read_at).toBe('2026-04-30T10:30:00Z');
        expect(result.home_mini_error).toBeNull();
    });

    test('parseResponse handles positive demand (grid import)', () => {
        const data = {
            smartMeterTelemetry: [
                { readAt: '2026-04-30T20:00:00Z', demand: '3500', consumptionDelta: '1750' }
            ]
        };
        const result = mini.parseResponse(data);
        expect(result.mini_demand_kw).toBeCloseTo(3.5);
        expect(result.mini_consumption_delta_kwh).toBeCloseTo(1.75);
    });

    test('parseResponse returns nulls when no telemetry data', () => {
        const result = mini.parseResponse({ smartMeterTelemetry: [] });
        expect(result.mini_demand_kw).toBeNull();
        expect(result.mini_consumption_delta_kwh).toBeNull();
        expect(result.home_mini_error).toBeNull();
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(mini.parseResponse({ smartMeterTelemetry: [] }));
        const populatedKeys = Object.keys(mini.parseResponse({
            smartMeterTelemetry: [{ demand: 1.2, consumptionDelta: 0.6, readAt: '2026-04-30T12:00:00Z' }]
        }));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(mini.defaultData).toHaveProperty(key);
        }
    });
});
