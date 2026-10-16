// __tests__/poll-tick-error-field.test.js
'use strict';
/**
 * runTick: the paths not covered by poll-tick.test.js / export-rate-error.test.js.
 * - a poll's own <id>_error (partial result) also goes to the category's errorField
 * - long own errors are capped under 255 characters in both fields
 * - the isStale hand-off (a newer tick took over) and disabled categories
 * Pure unit tests: no node, no network.
 */
const { runTick } = require('../lib/poll-tick');
const { MAX_ERROR_LENGTH } = require('../lib/graphql-errors');

function makeCat(id, pollImpl, extra = {}) {
    return { id, enabled: true, intervalMs: 60000, lastPolled: 0, poll: pollImpl, ...extra };
}

describe('runTick: own error with an errorField', () => {
    test('a partial result with its own error writes it to <id>_error and to the errorField', async () => {
        const cat = makeCat('x', jest.fn().mockResolvedValue({
            xField: 1, x_error: 'KT-CT-4501: Unable to fetch rates',
        }), { errorField: 'y_error' });
        const { state } = await runTick({
            categories: [cat], state: { x_error: null, y_error: null }, getToken: async () => 'TOK', now: () => 1,
        });
        expect(state.xField).toBe(1);
        expect(state.x_error).toBe('KT-CT-4501: Unable to fetch rates');
        expect(state.y_error).toBe('KT-CT-4501: Unable to fetch rates');
    });

    test('a partial result whose own error is null clears the errorField too', async () => {
        const cat = makeCat('x', jest.fn().mockResolvedValue({ xField: 2, x_error: null }), { errorField: 'y_error' });
        const { state } = await runTick({
            categories: [cat], state: { x_error: 'old', y_error: 'old' }, getToken: async () => 'TOK', now: () => 1,
        });
        expect(state.x_error).toBeNull();
        expect(state.y_error).toBeNull();
    });

    test('a long own error is capped in both fields', async () => {
        const long = `KT-CT-4301: ${'q'.repeat(2000)}`;
        const cat = makeCat('x', jest.fn().mockResolvedValue({ x_error: long }), { errorField: 'y_error' });
        const { state } = await runTick({
            categories: [cat], state: {}, getToken: async () => 'TOK', now: () => 1,
        });
        expect(state.x_error.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
        expect(state.x_error.startsWith('KT-CT-4301: qqq')).toBe(true);
        expect(state.x_error.endsWith('...')).toBe(true);
        expect(state.y_error).toBe(state.x_error);
    });

    test('a poll that resolves to nothing is a success: errors cleared, state kept', async () => {
        const cat = makeCat('x', jest.fn().mockResolvedValue(undefined), { errorField: 'y_error' });
        const { state, emitted } = await runTick({
            categories: [cat], state: { keep: 'me', x_error: 'old', y_error: 'old' }, getToken: async () => 'TOK', now: () => 5,
        });
        expect(emitted).toBe(true);
        expect(state.keep).toBe('me');
        expect(state.x_error).toBeNull();
        expect(state.y_error).toBeNull();
        expect(cat.lastPolled).toBe(5);
    });

    test('a thrown error does not leave the previous partial data behind', async () => {
        const cat = makeCat('x', jest.fn().mockRejectedValue(new Error('KT-CT-1111: Unauthorized')), { errorField: 'y_error' });
        const { state } = await runTick({
            categories: [cat], state: { xField: 'last-good' }, getToken: async () => 'TOK', now: () => 1,
        });
        expect(state.xField).toBe('last-good');
        expect(state.x_error).toBe('KT-CT-1111: Unauthorized');
        expect(state.y_error).toBe('KT-CT-1111: Unauthorized');
    });

    test('a category without errorField writes only <id>_error', async () => {
        const cat = makeCat('x', jest.fn().mockRejectedValue(new Error('boom')));
        const { state } = await runTick({
            categories: [cat], state: {}, getToken: async () => 'TOK', now: () => 1,
        });
        expect(state).toEqual({ x_error: 'boom' });
    });
});

describe('runTick: isStale hand-off', () => {
    test('passes isStale to each poll as the second argument', async () => {
        const isStale = jest.fn(() => false);
        const poll = jest.fn().mockResolvedValue({ a: 1 });
        await runTick({ categories: [makeCat('a', poll)], state: {}, getToken: async () => 'TOK', now: () => 1, isStale });
        expect(poll).toHaveBeenCalledWith('TOK', isStale);
    });

    test('without isStale the poll gets the token only', async () => {
        const poll = jest.fn().mockResolvedValue({ a: 1 });
        await runTick({ categories: [makeCat('a', poll)], state: {}, getToken: async () => 'TOK', now: () => 1 });
        expect(poll.mock.calls[0]).toEqual(['TOK']);
    });

    test('stops before the next category once a newer tick has taken over', async () => {
        let stale = false;
        const pollA = jest.fn(async () => { stale = true; return { a: 1 }; });
        const pollB = jest.fn().mockResolvedValue({ b: 2 });
        const catA = makeCat('a', pollA);
        const catB = makeCat('b', pollB);
        const { state, emitted } = await runTick({
            categories: [catA, catB], state: {}, getToken: async () => 'TOK', now: () => 42, isStale: () => stale,
        });
        expect(pollA).toHaveBeenCalledTimes(1);
        expect(pollB).not.toHaveBeenCalled();
        expect(state.a).toBe(1);
        expect(state).not.toHaveProperty('b');
        // Since 1.6.2 (review5 R6) a superseded tick marks nothing polled: the newer tick re-polls a and b.
        expect(catA.lastPolled).toBe(0);
        expect(catB.lastPolled).toBe(0);
        expect(emitted).toBe(true);
    });

    test('already stale before the first category: nothing is polled', async () => {
        const poll = jest.fn();
        const cat = makeCat('a', poll);
        const { state } = await runTick({
            categories: [cat], state: { a: 'keep' }, getToken: async () => 'TOK', now: () => 1, isStale: () => true,
        });
        expect(poll).not.toHaveBeenCalled();
        expect(state).toEqual({ a: 'keep' });
        expect(cat.lastPolled).toBe(0);
    });
});

describe('runTick: disabled categories', () => {
    test('a disabled category is never polled and its error is left alone', async () => {
        const off = makeCat('off', jest.fn(), { enabled: false });
        const on = makeCat('on', jest.fn().mockResolvedValue({ v: 1 }));
        const { state } = await runTick({
            categories: [off, on], state: { off_error: 'stale' }, getToken: async () => 'TOK', now: () => 1,
        });
        expect(off.poll).not.toHaveBeenCalled();
        expect(state.off_error).toBe('stale');
        expect(state.v).toBe(1);
    });

    test('an auth failure does not touch disabled categories', async () => {
        const off = makeCat('off', jest.fn(), { enabled: false, errorField: 'off_extra_error' });
        const on = makeCat('on', jest.fn());
        const { state } = await runTick({
            categories: [off, on], state: {}, getToken: async () => { throw new Error('nope'); }, now: () => 1,
        });
        expect(state).toEqual({ on_error: 'Auth failed: nope' });
        expect(off.lastPolled).toBe(0);
    });
});
