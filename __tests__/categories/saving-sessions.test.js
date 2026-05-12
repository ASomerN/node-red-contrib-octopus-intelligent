'use strict';
const ss = require('../../lib/categories/saving-sessions');

const mockResponse = {
    savingSessions: {
        events: [
            { id: 'evt-1', code: 'SS2026-001', rewardPerKwhInOctoPoints: 800, startAt: '2026-10-15T17:00:00Z', endAt: '2026-10-15T18:00:00Z' }
        ],
        account: {
            hasJoinedCampaign: true,
            joinedEvents: [{ eventId: 'evt-1', startAt: '2026-10-15T17:00:00Z', endAt: '2026-10-15T18:00:00Z', rewardGivenInOctoPoints: 800 }]
        }
    }
};

describe('saving-sessions category', () => {
    test('buildQuery routes to backend hostname with savingSessions field', () => {
        const { query, variables, hostname } = ss.buildQuery('A-AAA-1234');
        expect(query).toMatch(/\{\s*savingSessions/);
        expect(query).toContain('account(accountNumber: $account)');
        expect(variables.account).toBe('A-AAA-1234');
        expect(hostname).toBe('api.backend.octopus.energy');
    });

    test('parseResponse extracts next event and joined status', () => {
        const result = ss.parseResponse(mockResponse);
        expect(result.saving_session_available).toBe(true);
        expect(result.saving_session_start).toBe('2026-10-15T17:00:00Z');
        expect(result.saving_session_end).toBe('2026-10-15T18:00:00Z');
        expect(result.saving_session_joined).toBe(true);
        expect(result.saving_sessions_error).toBeNull();
    });

    test('parseResponse returns false available when no events', () => {
        const data = { savingSessions: { events: [], account: { joinedEvents: [] } } };
        const result = ss.parseResponse(data);
        expect(result.saving_session_available).toBe(false);
        expect(result.saving_session_joined).toBe(false);
    });

    test('parseResponse handles missing savingSessions gracefully', () => {
        const result = ss.parseResponse({});
        expect(result.saving_session_available).toBe(false);
        expect(result.saving_session_joined).toBe(false);
    });

    test('defaultData covers every field that parseResponse can emit', () => {
        const emptyKeys = Object.keys(ss.parseResponse({}));
        const populatedKeys = Object.keys(ss.parseResponse(mockResponse));
        for (const key of new Set([...emptyKeys, ...populatedKeys])) {
            expect(ss.defaultData).toHaveProperty(key);
        }
    });
});
