// __tests__/force-during-poll.test.js
'use strict';
/**
 * A category forced due (forceCategoryDue: lastPolled = 0, forceSeq + 1) while it is
 * already being polled must stay due when that poll ends. Before, runTick set
 * lastPolled = now() after the poll and the forced re-poll was lost until the next slot,
 * so a plan change, manual refresh or check after a write could be missed.
 */
const { runTick } = require('../lib/poll-tick');

function force(cat) {
    cat.forceSeq = (cat.forceSeq || 0) + 1;
    cat.lastPolled = 0;
}

const makeCat = (poll) => ({ id: 'intelligent', enabled: true, intervalMs: 300000, lastPolled: 0, poll });

test('a force that lands during the poll keeps the category due', async () => {
    const cat = makeCat(null);
    cat.poll = jest.fn(async () => { force(cat); return {}; });
    await runTick({ categories: [cat], state: {}, getToken: async () => 'TOK', now: () => 5000 });
    expect(cat.lastPolled).toBe(0);
});

test('a force that lands during a failed poll keeps the category due', async () => {
    const cat = makeCat(null);
    cat.poll = jest.fn(async () => { force(cat); throw new Error('boom'); });
    await runTick({ categories: [cat], state: {}, getToken: async () => 'TOK', now: () => 5000 });
    expect(cat.lastPolled).toBe(0);
});

test('a force that lands while the token is fetched keeps the category due after an auth failure', async () => {
    const cat = makeCat(jest.fn());
    const getToken = async () => { force(cat); throw new Error('nope'); };
    await runTick({ categories: [cat], state: {}, getToken, now: () => 5000 });
    expect(cat.lastPolled).toBe(0);
});

test('with no force during the poll, lastPolled is the poll time', async () => {
    const cat = makeCat(jest.fn().mockResolvedValue({}));
    force(cat); // forced before the tick: this tick is the forced poll
    await runTick({ categories: [cat], state: {}, getToken: async () => 'TOK', now: () => 5000 });
    expect(cat.lastPolled).toBe(5000);
});
