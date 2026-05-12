'use strict';
const fe = require('../../lib/categories/free-electricity');

// Fixed reference time: 2026-05-04T10:00:00Z
const NOW = '2026-05-04T10:00:00Z';

// Helper to build a mock API response with given sessions
function makeResponse(sessions) {
    return {
        customerFlexibilityCampaignEvents: {
            edges: sessions.map(s => ({ node: { code: 'FE001', startAt: s.startAt, endAt: s.endAt } }))
        }
    };
}

describe('free-electricity category', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    // --- buildQuery tests ---

    test('buildQuery includes customerFlexibilityCampaignEvents', () => {
        const { query } = fe.buildQuery('A-AAA-1234', '1234567890');
        expect(query).toContain('customerFlexibilityCampaignEvents');
    });

    test('buildQuery includes $mpan variable', () => {
        const { query } = fe.buildQuery('A-AAA-1234', '1234567890');
        expect(query).toContain('$mpan');
    });

    test('buildQuery includes campaignSlug free_electricity', () => {
        const { query } = fe.buildQuery('A-AAA-1234', '1234567890');
        expect(query).toContain('free_electricity');
    });

    test('buildQuery passes account and mpan as variables', () => {
        const { variables } = fe.buildQuery('A-AAA-1234', '9876543210');
        expect(variables.account).toBe('A-AAA-1234');
        expect(variables.mpan).toBe('9876543210');
    });

    // --- parseResponse tests ---

    test('parseResponse returns active=true when current time is within a session window', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));

        const data = makeResponse([
            { startAt: '2026-05-04T09:30:00Z', endAt: '2026-05-04T11:00:00Z' }
        ]);
        const result = fe.parseResponse(data);

        expect(result.free_electricity_active).toBe(true);
        expect(result.free_electricity_available).toBe(true);
        expect(result.free_electricity_start).toBe('2026-05-04T09:30:00Z');
        expect(result.free_electricity_end).toBe('2026-05-04T11:00:00Z');
        expect(result.free_electricity_error).toBeNull();
    });

    test('parseResponse returns active=false, available=true when session is upcoming', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));

        const data = makeResponse([
            { startAt: '2026-05-04T14:00:00Z', endAt: '2026-05-04T15:30:00Z' }
        ]);
        const result = fe.parseResponse(data);

        expect(result.free_electricity_active).toBe(false);
        expect(result.free_electricity_available).toBe(true);
        expect(result.free_electricity_start).toBe('2026-05-04T14:00:00Z');
        expect(result.free_electricity_end).toBe('2026-05-04T15:30:00Z');
    });

    test('parseResponse returns active=false, available=false when all sessions are in the past', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));

        const data = makeResponse([
            { startAt: '2026-05-04T06:00:00Z', endAt: '2026-05-04T07:30:00Z' },
            { startAt: '2026-05-04T08:00:00Z', endAt: '2026-05-04T09:00:00Z' }
        ]);
        const result = fe.parseResponse(data);

        expect(result.free_electricity_active).toBe(false);
        expect(result.free_electricity_available).toBe(false);
        expect(result.free_electricity_start).toBeNull();
        expect(result.free_electricity_end).toBeNull();
    });

    test('parseResponse returns active=false, available=false when no sessions returned', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));

        const result = fe.parseResponse(makeResponse([]));

        expect(result.free_electricity_active).toBe(false);
        expect(result.free_electricity_available).toBe(false);
        expect(result.free_electricity_start).toBeNull();
        expect(result.free_electricity_end).toBeNull();
    });

    test('parseResponse picks the soonest upcoming session when multiple future sessions exist', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));

        const data = makeResponse([
            { startAt: '2026-05-04T18:00:00Z', endAt: '2026-05-04T19:30:00Z' },
            { startAt: '2026-05-04T12:00:00Z', endAt: '2026-05-04T13:30:00Z' },
            { startAt: '2026-05-05T08:00:00Z', endAt: '2026-05-05T09:30:00Z' }
        ]);
        const result = fe.parseResponse(data);

        // Should pick the one at 12:00 (soonest)
        expect(result.free_electricity_start).toBe('2026-05-04T12:00:00Z');
        expect(result.free_electricity_end).toBe('2026-05-04T13:30:00Z');
        expect(result.free_electricity_active).toBe(false);
        expect(result.free_electricity_available).toBe(true);
    });

    test('parseResponse handles missing customerFlexibilityCampaignEvents gracefully', () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW));

        const result = fe.parseResponse({});

        expect(result.free_electricity_active).toBe(false);
        expect(result.free_electricity_available).toBe(false);
        expect(result.free_electricity_error).toBeNull();
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(fe.parseResponse({}));
        for (const key of emptyKeys) {
            expect(fe.defaultData).toHaveProperty(key);
        }
    });
});
