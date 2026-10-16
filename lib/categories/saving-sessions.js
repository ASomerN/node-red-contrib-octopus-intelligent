'use strict';
const { capStrings } = require('../values');

// savingSessions moved to api.backend.octopus.energy — the field was removed
// from api.octopus.energy. Requires User-Agent header (set in lib/graphql.js)
// to avoid edge 403 on the backend endpoint.
// octopoints removed from SavingSessionsAccountType — fetch via octoplus category instead.
const QUERY = `
query getSavingSessions($account: String!) {
    savingSessions {
        events(includeDev: false) {
            id code rewardPerKwhInOctoPoints startAt endAt
        }
        account(accountNumber: $account) {
            hasJoinedCampaign
            joinedEvents { eventId startAt endAt rewardGivenInOctoPoints }
        }
    }
}`;

function buildQuery(account) {
    return {
        query: QUERY,
        variables: { account },
        hostname: 'api.backend.octopus.energy'
    };
}

function parseResponse(data) {
    const now = new Date();
    const ss = data.savingSessions || {};
    const acct = ss.account || {};
    const events = ss.events || [];

    // Filter to events not yet ended; sort earliest-first; take the first
    const upcoming = events
        .filter(e => new Date(e.endAt) > now)
        .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    const next = upcoming[0] || null;

    const joinedIds = (acct.joinedEvents || []).map(e => e.eventId);
    const isJoined = next ? joinedIds.includes(next.id) : false;

    const inWindow = next
        && new Date(next.startAt) <= now
        && new Date(next.endAt) > now;

    return {
        saving_session_available: next !== null,
        saving_session_start: next ? next.startAt : null,
        saving_session_end: next ? next.endAt : null,
        saving_session_joined: isJoined,
        saving_session_window_active: !!inWindow,
        saving_session_active: !!(inWindow && isJoined),
        saving_sessions_error: null
    };
}

// Window/active flags for `nowMs` from the stored next session (state from parseResponse).
// Used on the node's 10 s tick so they switch at the session start/end, not at the next poll.
function activeFields(state, nowMs) {
    if (!state.saving_session_start || !state.saving_session_end) return {};
    const inWindow = new Date(state.saving_session_start).getTime() <= nowMs
        && new Date(state.saving_session_end).getTime() > nowMs;
    return {
        saving_session_window_active: inWindow,
        saving_session_active: inWindow && state.saving_session_joined === true,
    };
}

const defaultData = {
    saving_session_available: null, saving_session_start: null, saving_session_end: null,
    saving_session_joined: null, saving_session_window_active: null, saving_session_active: null,
    saving_sessions_error: null
};

// Text fields cut to the HA state limit (lib/values.js).
module.exports = { buildQuery, parseResponse: capStrings(parseResponse), activeFields, defaultData };
