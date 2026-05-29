'use strict';
const { simplePoll } = require('../lib/poll-tick');

describe('simplePoll', () => {
    const queryFn = () => ({ query: 'Q', variables: { x: 1 }, hostname: 'api.octopus.energy' });
    const parseFn = (d) => ({ foo: d.foo * 2 });

    it('returns parsed payload on success', async () => {
        const graphqlPost = jest.fn().mockResolvedValue({ data: { data: { foo: 7 } } });
        const poll = simplePoll(queryFn, parseFn, graphqlPost);
        await expect(poll('TOK')).resolves.toEqual({ foo: 14 });
        expect(graphqlPost).toHaveBeenCalledWith({ query: 'Q', variables: { x: 1 } }, 'TOK', 'api.octopus.energy');
    });
    it('throws on data.errors', async () => {
        const graphqlPost = jest.fn().mockResolvedValue({ data: { errors: [{ message: 'KT-CT-1199' }] } });
        await expect(simplePoll(queryFn, parseFn, graphqlPost)('TOK')).rejects.toThrow(/KT-CT-1199/);
    });
    it('throws on missing data field', async () => {
        const graphqlPost = jest.fn().mockResolvedValue({ data: {} });
        await expect(simplePoll(queryFn, parseFn, graphqlPost)('TOK')).rejects.toThrow(/missing data/i);
    });
});

const { runTick } = require('../lib/poll-tick');

function makeCat(id, intervalMs, pollImpl) {
    return { id, enabled: true, intervalMs, lastPolled: 0, poll: pollImpl };
}

describe('runTick — happy path', () => {
    it('polls due categories, merges, advances lastPolled, emits once', async () => {
        const catA = makeCat('a', 60000, jest.fn().mockResolvedValue({ aField: 1 }));
        const catB = makeCat('b', 60000, jest.fn().mockResolvedValue({ bField: 2 }));
        const getToken = jest.fn().mockResolvedValue('TOK');
        const result = await runTick({
            categories: [catA, catB],
            state: { aField: null, bField: null, a_error: null, b_error: null },
            getToken,
            now: () => 1000,
        });
        expect(getToken).toHaveBeenCalledTimes(1);
        expect(catA.poll).toHaveBeenCalledWith('TOK');
        expect(catB.poll).toHaveBeenCalledWith('TOK');
        expect(result.emitted).toBe(true);
        expect(result.state).toEqual({ aField: 1, bField: 2, a_error: null, b_error: null });
        expect(catA.lastPolled).toBe(1000);
        expect(catB.lastPolled).toBe(1000);
    });
    it('returns emitted=false and does not auth when nothing is due', async () => {
        const cat = makeCat('a', 60000, jest.fn());
        cat.lastPolled = Date.now();
        const getToken = jest.fn();
        const result = await runTick({ categories: [cat], state: {}, getToken, now: Date.now });
        expect(result.emitted).toBe(false);
        expect(getToken).not.toHaveBeenCalled();
        expect(cat.poll).not.toHaveBeenCalled();
    });
});

describe('runTick — category failure', () => {
    it('sets <id>_error, keeps last-good, advances lastPolled, does not disable', async () => {
        const catA = makeCat('a', 60000, jest.fn().mockRejectedValue(new Error('boom')));
        const catB = makeCat('b', 60000, jest.fn().mockResolvedValue({ bField: 9 }));
        const result = await runTick({
            categories: [catA, catB],
            state: { aField: 'last-good', bField: null, a_error: null, b_error: null },
            getToken: async () => 'TOK',
            now: () => 5000,
        });
        expect(result.state.aField).toBe('last-good');
        expect(result.state.a_error).toMatch(/boom/);
        expect(result.state.bField).toBe(9);
        expect(catA.enabled).toBe(true);
        expect(catA.lastPolled).toBe(5000);
    });
});

describe('runTick — auth failure', () => {
    it('records auth error on each due category, advances lastPolled, makes no poll calls, still emits', async () => {
        const catA = makeCat('a', 60000, jest.fn());
        const catB = makeCat('b', 60000, jest.fn());
        const getToken = jest.fn().mockRejectedValue(new Error('auth boom'));
        const result = await runTick({
            categories: [catA, catB],
            state: { aField: 'keep', bField: 'keep', a_error: null, b_error: null },
            getToken,
            now: () => 7000,
        });
        expect(catA.poll).not.toHaveBeenCalled();
        expect(catB.poll).not.toHaveBeenCalled();
        expect(result.state.a_error).toMatch(/auth boom/);
        expect(result.state.b_error).toMatch(/auth boom/);
        expect(result.state.aField).toBe('keep');
        expect(catA.lastPolled).toBe(7000);
        expect(result.emitted).toBe(true);
    });
});

describe('runTick — recovery', () => {
    it('clears <id>_error to null when a previously-failed category now succeeds', async () => {
        const cat = makeCat('a', 60000, jest.fn().mockResolvedValue({ aField: 42 }));
        const result = await runTick({
            categories: [cat],
            state: { aField: null, a_error: 'previous failure' },
            getToken: async () => 'TOK',
            now: () => 9000,
        });
        expect(result.state.a_error).toBeNull();
        expect(result.state.aField).toBe(42);
    });
});
