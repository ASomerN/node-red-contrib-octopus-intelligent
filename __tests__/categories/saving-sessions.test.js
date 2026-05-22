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

    // Helper to build a savingSessions response shape with optional joined eventIds
    function buildResponse(events, joinedEventIds = []) {
        return {
            savingSessions: {
                events,
                account: {
                    hasJoinedCampaign: joinedEventIds.length > 0,
                    joinedEvents: joinedEventIds.map(id => ({ eventId: id }))
                }
            }
        };
    }

    test('saving_session_available true only when an upcoming event exists', () => {
        const result = ss.parseResponse(
            buildResponse([{ id: '1', startAt: '2099-12-10T18:00:00Z', endAt: '2099-12-10T19:00:00Z' }])
        );
        expect(result.saving_session_available).toBe(true);
        expect(result.saving_session_start).toBe('2099-12-10T18:00:00Z');
        expect(result.saving_session_end).toBe('2099-12-10T19:00:00Z');
    });

    test('saving_session_available false when only past events exist', () => {
        const result = ss.parseResponse(
            buildResponse([{ id: '1', startAt: '2020-01-01T00:00:00Z', endAt: '2020-01-01T01:00:00Z' }])
        );
        expect(result.saving_session_available).toBe(false);
        expect(result.saving_session_start).toBeNull();
        expect(result.saving_session_end).toBeNull();
    });

    test('picks the earliest upcoming event when multiple exist', () => {
        const result = ss.parseResponse(
            buildResponse([
                { id: 'L', startAt: '2099-12-15T18:00:00Z', endAt: '2099-12-15T19:00:00Z' },
                { id: 'P', startAt: '2020-01-01T00:00:00Z', endAt: '2020-01-01T01:00:00Z' },
                { id: 'E', startAt: '2099-12-10T18:00:00Z', endAt: '2099-12-10T19:00:00Z' }
            ])
        );
        expect(result.saving_session_start).toBe('2099-12-10T18:00:00Z');
    });

    test('saving_session_window_active true when current time is within event window', () => {
        const pastIso = new Date(Date.now() - 60_000).toISOString();      // 1 min ago
        const futureIso = new Date(Date.now() + 60_000).toISOString();    // 1 min from now
        const result = ss.parseResponse(
            buildResponse([{ id: '1', startAt: pastIso, endAt: futureIso }])
        );
        expect(result.saving_session_window_active).toBe(true);
    });

    test('saving_session_window_active false when event has not yet started', () => {
        const future1 = new Date(Date.now() + 60_000).toISOString();
        const future2 = new Date(Date.now() + 120_000).toISOString();
        const result = ss.parseResponse(
            buildResponse([{ id: '1', startAt: future1, endAt: future2 }])
        );
        expect(result.saving_session_window_active).toBe(false);
    });

    test('saving_session_window_active false when event has already ended', () => {
        const result = ss.parseResponse(
            buildResponse([{ id: '1', startAt: '2020-01-01T00:00:00Z', endAt: '2020-01-01T01:00:00Z' }])
        );
        expect(result.saving_session_window_active).toBe(false);
    });

    test('saving_session_active true only when joined AND in window', () => {
        const pastIso = new Date(Date.now() - 60_000).toISOString();
        const futureIso = new Date(Date.now() + 60_000).toISOString();
        const result = ss.parseResponse(
            buildResponse([{ id: '42', startAt: pastIso, endAt: futureIso }], ['42'])
        );
        expect(result.saving_session_window_active).toBe(true);
        expect(result.saving_session_joined).toBe(true);
        expect(result.saving_session_active).toBe(true);
    });

    test('saving_session_active false when in window but not joined', () => {
        const pastIso = new Date(Date.now() - 60_000).toISOString();
        const futureIso = new Date(Date.now() + 60_000).toISOString();
        const result = ss.parseResponse(
            buildResponse([{ id: '42', startAt: pastIso, endAt: futureIso }])  // joinedEventIds empty
        );
        expect(result.saving_session_window_active).toBe(true);
        expect(result.saving_session_joined).toBe(false);
        expect(result.saving_session_active).toBe(false);
    });
});
