// __tests__/categories/completed-dispatches.test.js
'use strict';
const cd = require('../../lib/categories/completed-dispatches');

const mockResponse = {
    completedDispatches: [
        { start: '2026-04-28T01:00:00Z', end: '2026-04-28T03:00:00Z', delta: '12.5', meta: { source: 'smart-charge', location: null } },
        { start: '2026-04-27T01:00:00Z', end: '2026-04-27T02:30:00Z', delta: '8.0', meta: { source: 'smart-charge', location: null } }
    ]
};

describe('completed-dispatches category', () => {
    test('buildQuery includes completedDispatches', () => {
        const { query } = cd.buildQuery('A-TEST-1234');
        expect(query).toContain('completedDispatches');
        expect(query).toContain('$account');
    });

    test('parseResponse extracts dispatches array', () => {
        const result = cd.parseResponse(mockResponse);
        expect(result.completed_dispatches_count).toBe(2);
        expect(result.completed_dispatches[0].start).toBe('2026-04-28T01:00:00Z');
        expect(result.completed_dispatches[0].delta_kwh).toBe(12.5);
        expect(result.completed_dispatches[0].source).toBe('smart-charge');
        expect(result.completed_dispatches_error).toBeNull();
    });

    test('parseResponse handles null delta', () => {
        const result = cd.parseResponse({ completedDispatches: [{ start: 'x', end: 'y', delta: null, meta: {} }] });
        expect(result.completed_dispatches[0].delta_kwh).toBeNull();
    });

    test('parseResponse returns empty array when no dispatches', () => {
        const result = cd.parseResponse({ completedDispatches: [] });
        expect(result.completed_dispatches).toEqual([]);
        expect(result.completed_dispatches_count).toBe(0);
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(cd.parseResponse({}));
        const populatedKeys = Object.keys(cd.parseResponse(mockResponse));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(cd.defaultData).toHaveProperty(key);
        }
    });
});
