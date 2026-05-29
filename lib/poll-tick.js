'use strict';

function simplePoll(queryFn, parseFn, graphqlPost) {
    return async function poll(token) {
        const { query, variables, hostname } = queryFn();
        const response = await graphqlPost({ query, variables }, token, hostname);
        if (response.data.errors) throw new Error(JSON.stringify(response.data.errors));
        if (!response.data.data) throw new Error('Response missing data');
        return parseFn(response.data.data);
    };
}

const { isDue } = require('./scheduler');
const { mergePayload } = require('./payload');

async function runTick({ categories, state, getToken, now = Date.now }) {
    const due = categories.filter((c) => c.enabled && isDue(c));
    if (due.length === 0) return { state, emitted: false };
    let token;
    try {
        token = await getToken();
    } catch (e) {
        let newState = state;
        for (const cat of due) {
            newState = mergePayload(newState, { [`${cat.id}_error`]: `Auth failed: ${e.message}` });
            cat.lastPolled = now();
        }
        return { state: newState, emitted: true };
    }
    let newState = state;
    for (const cat of due) {
        try {
            const partial = await cat.poll(token);
            newState = mergePayload(newState, partial);
            newState = mergePayload(newState, { [`${cat.id}_error`]: null });
        } catch (e) {
            newState = mergePayload(newState, { [`${cat.id}_error`]: e.message });
        }
        cat.lastPolled = now();
    }
    return { state: newState, emitted: true };
}

module.exports = { simplePoll, runTick };
