// __tests__/categories/flex-planned-dispatches.test.js
'use strict';
const fpd = require('../../lib/categories/flex-planned-dispatches');

const mockResponse = {
    flexPlannedDispatches: [
        { start: '2026-04-30T23:00:00Z', end: '2026-05-01T05:00:00Z', type: 'SMART_CHARGE', energyAddedKwh: '45.5' },
        { start: '2026-05-01T23:00:00Z', end: '2026-05-02T05:00:00Z', type: 'SMART_CHARGE', energyAddedKwh: null }
    ]
};

describe('flex-planned-dispatches category', () => {
    test('buildQuery uses deviceId variable', () => {
        const { query, variables } = fpd.buildQuery('device-123');
        expect(query).toContain('flexPlannedDispatches');
        expect(query).toContain('$deviceId');
        expect(variables.deviceId).toBe('device-123');
    });

    test('parseResponse extracts dispatches with parsed energy', () => {
        const result = fpd.parseResponse(mockResponse);
        expect(result.flex_planned_dispatches_count).toBe(2);
        expect(result.flex_planned_dispatches[0].start).toBe('2026-04-30T23:00:00Z');
        expect(result.flex_planned_dispatches[0].type).toBe('SMART_CHARGE');
        expect(result.flex_planned_dispatches[0].energy_kwh).toBe(45.5);
        expect(result.flex_planned_dispatches_error).toBeNull();
    });

    test('parseResponse handles null energyAddedKwh', () => {
        const result = fpd.parseResponse(mockResponse);
        expect(result.flex_planned_dispatches[1].energy_kwh).toBeNull();
    });

    test('parseResponse returns empty array when no dispatches', () => {
        const result = fpd.parseResponse({ flexPlannedDispatches: [] });
        expect(result.flex_planned_dispatches).toEqual([]);
        expect(result.flex_planned_dispatches_count).toBe(0);
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(fpd.parseResponse({}));
        const populatedKeys = Object.keys(fpd.parseResponse(mockResponse));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(fpd.defaultData).toHaveProperty(key);
        }
    });
});
