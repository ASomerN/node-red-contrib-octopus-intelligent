'use strict';

const { graphqlError, truncate, isNetworkError } = require('./graphql-errors');

// Every <category>_error is short text ("KT-CT-1111: Unauthorized" or the plain message),
// never the raw Kraken errors JSON, and under 255 characters: Home Assistant rejects a
// longer state.
function simplePoll(queryFn, parseFn, graphqlPost) {
    return async function poll(token) {
        const { query, variables, hostname } = queryFn();
        const response = await graphqlPost({ query, variables }, token, hostname);
        if (response.data.errors) throw graphqlError(response.data.errors);
        if (!response.data.data) throw new Error('Response missing data');
        return parseFn(response.data.data);
    };
}

const { isDue } = require('./scheduler');
const { mergePayload } = require('./payload');

// A category's error goes to <id>_error and, when the category sets errorField, to that field
// too (the export rates poll feeds the Electricity Export Rate Error sensors this way).
function errorUpdate(cat, value) {
    const update = { [`${cat.id}_error`]: value };
    if (cat.errorField) update[cat.errorField] = value;
    return update;
}

// Mark a category polled, unless it was forced due (forceCategoryDue bumps forceSeq) after
// `seq` was read: then it stays due, so the forced poll isn't lost behind one in flight.
function markPolled(cat, seq, at) {
    cat.lastPolled = (cat.forceSeq || 0) !== seq ? 0 : at;
}

// After a failed token request a category is retried after 60 s, then 2, 4, 8 and at most
// 10 minutes while auth keeps failing, rather than waiting a whole interval (up to an hour)
// or trying again every second. Its normal slot still applies if that comes sooner.
const AUTH_RETRY_BASE_MS = 60000;
const AUTH_RETRY_MAX_MS = 600000;

function authRetryDelay(failures) {
    return Math.min(AUTH_RETRY_BASE_MS * 2 ** (Math.max(failures, 1) - 1), AUTH_RETRY_MAX_MS);
}

// update_check reads npm, not Octopus: it sets needsToken: false.
const needsToken = (cat) => cat.needsToken !== false;

async function runTick({ categories, state, getToken, now = Date.now, isStale }) {
    const due = categories.filter((c) => c.enabled && isDue(c));
    if (due.length === 0) return { state, changes: {}, emitted: false };
    // `changes` holds only what this tick wrote, so the caller can apply it onto its current
    // state: anything written there while the tick waited on Octopus is kept.
    let newState = state;
    let changes = {};
    const apply = (partial) => {
        newState = mergePayload(newState, partial);
        changes = mergePayload(changes, partial);
    };
    let toPoll = due;
    let token;
    if (due.some(needsToken)) {
        const seqAtAuth = due.map((c) => c.forceSeq || 0);
        try {
            token = await getToken();
        } catch (e) {
            const text = truncate(`Auth failed: ${e.message}`);
            due.forEach((cat, i) => {
                if (!needsToken(cat)) return;
                apply(errorUpdate(cat, text));
                markPolled(cat, seqAtAuth[i], now());
                cat.authFailures = (cat.authFailures || 0) + 1;
                // A rate-limited token request (429 with Retry-After) waits at least that long.
                const wait = Number.isFinite(e && e.retryAfterMs) ? Math.min(e.retryAfterMs, AUTH_RETRY_MAX_MS) : 0;
                cat.authRetryAt = now() + Math.max(authRetryDelay(cat.authFailures), wait);
            });
            // Categories that need no token still run.
            toPoll = due.filter((cat) => !needsToken(cat));
        }
    }
    // Set after the first time-out, dropped connection or HTTP 5xx from Octopus. The other
    // Octopus categories are then left due for the next tick rather than each waiting up to
    // 30 s here, so an outage can't make one tick run for 10 minutes.
    let octopusDown = false;
    // Marked polled only when the tick ends current: a tick replaced by a newer one (the
    // watchdog in lib/scheduler.js) has its results dropped by the caller, so what it polled
    // must stay due for the newer tick.
    const polled = [];
    for (const cat of toPoll) {
        // A newer tick has taken over: stop here so categories aren't polled twice.
        if (isStale && isStale()) break;
        if (octopusDown && needsToken(cat)) continue;
        const seq = cat.forceSeq || 0;
        // Auth worked (or isn't needed): back to the normal interval.
        cat.authFailures = 0;
        cat.authRetryAt = null;
        try {
            const partial = await (isStale ? cat.poll(token, isStale) : cat.poll(token));
            apply(partial);
            // A poll that kept part of its data can report what failed in <id>_error.
            const ownError = partial && partial[`${cat.id}_error`];
            apply(errorUpdate(cat, ownError ? truncate(ownError) : null));
        } catch (e) {
            apply(errorUpdate(cat, truncate(e.message)));
            if (needsToken(cat) && isNetworkError(e)) octopusDown = true;
        }
        polled.push({ cat, seq, at: now() });
    }
    if (!(isStale && isStale())) polled.forEach(({ cat, seq, at }) => markPolled(cat, seq, at));
    return { state: newState, changes, emitted: true };
}

module.exports = { simplePoll, runTick, AUTH_RETRY_BASE_MS, AUTH_RETRY_MAX_MS };
