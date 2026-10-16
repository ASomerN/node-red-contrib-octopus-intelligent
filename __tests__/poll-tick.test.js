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

describe('runTick — partial result with its own error (1.7.0)', () => {
    it('keeps an <id>_error the poll returned with its data, and merges the data', async () => {
        const cat = makeCat('a', 60000, jest.fn().mockResolvedValue({ aField: 1, a_error: 'KT-CT-4301: Unable to fetch charging sessions' }));
        const result = await runTick({
            categories: [cat],
            state: { aField: null, bField: 'keep', a_error: null },
            getToken: async () => 'TOK',
            now: () => 9000,
        });
        expect(result.state.aField).toBe(1);
        expect(result.state.bField).toBe('keep');
        expect(result.state.a_error).toBe('KT-CT-4301: Unable to fetch charging sessions');
    });

    it('still clears <id>_error when the poll returns it as null', async () => {
        const cat = makeCat('a', 60000, jest.fn().mockResolvedValue({ aField: 2, a_error: null }));
        const result = await runTick({
            categories: [cat],
            state: { aField: null, a_error: 'previous failure' },
            getToken: async () => 'TOK',
            now: () => 9000,
        });
        expect(result.state.a_error).toBeNull();
    });
});

describe('short <category>_error text (1.6.2)', () => {
    const { MAX_ERROR_LENGTH } = require('../lib/graphql-errors');
    const queryFn = () => ({ query: 'Q', variables: {} });
    const parseFn = (d) => d;
    const failing = (errors) => simplePoll(queryFn, parseFn, jest.fn().mockResolvedValue({ data: { errors } }));
    const tickWith = (poll) => runTick({
        categories: [makeCat('account', 60000, poll)],
        state: { account_error: null },
        getToken: async () => 'TOK',
        now: () => 1000,
    });

    it('a GraphQL error with a Kraken code reads "CODE: message", not raw JSON', async () => {
        const { state } = await tickWith(failing([
            { message: 'Unauthorized.', path: ['account'], extensions: { errorCode: 'KT-CT-1111', errorType: 'AUTHORIZATION' } },
        ]));
        expect(state.account_error).toBe('KT-CT-1111: Unauthorized');
    });

    it('a GraphQL error without a code gives the plain message', async () => {
        const { state } = await tickWith(failing([{ message: 'Something went wrong.', path: ['account'] }]));
        expect(state.account_error).toBe('Something went wrong');
        expect(state.account_error).not.toMatch(/[{}[\]]/);
    });

    it('a 2000-character Kraken message is capped under 255 characters', async () => {
        const { state } = await tickWith(failing([
            { message: 'z'.repeat(2000), extensions: { errorCode: 'KT-CT-4340' } },
        ]));
        expect(state.account_error.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
        expect(state.account_error.length).toBeLessThan(255);
        expect(state.account_error.startsWith('KT-CT-4340: zzz')).toBe(true);
        expect(state.account_error.endsWith('...')).toBe(true);
    });

    it('a transport error (timeout or HTTP) is kept as text and capped', async () => {
        const timeout = simplePoll(queryFn, parseFn,
            jest.fn().mockRejectedValue(new Error('Octopus API request timed out after 30s')));
        expect((await tickWith(timeout)).state.account_error).toBe('Octopus API request timed out after 30s');

        const http = simplePoll(queryFn, parseFn,
            jest.fn().mockRejectedValue(new Error(`Failed to parse API response: <html>${'x'.repeat(2000)}</html>`)));
        const { state } = await tickWith(http);
        expect(state.account_error.length).toBeLessThan(255);
        expect(state.account_error.startsWith('Failed to parse API response')).toBe(true);
    });

    it('a long auth failure is capped on every due category', async () => {
        const result = await runTick({
            categories: [makeCat('a', 60000, jest.fn()), makeCat('b', 60000, jest.fn())],
            state: {},
            getToken: jest.fn().mockRejectedValue(new Error('y'.repeat(2000))),
            now: () => 1000,
        });
        expect(result.state.a_error.length).toBeLessThan(255);
        expect(result.state.a_error.startsWith('Auth failed: yyy')).toBe(true);
        expect(result.state.b_error.length).toBeLessThan(255);
    });
});

// Sweep 2026-10-08 #2: the node applies only the tick's own changes onto its current state,
// so state written while the tick ran (a validation poll, a Charge Cap change) survives.
describe('runTick — changes', () => {
    it('returns only the fields this tick changed, not the start-of-tick state', async () => {
        const catA = makeCat('a', 60000, jest.fn().mockResolvedValue({ aField: 1 }));
        const catB = makeCat('b', 60000, jest.fn().mockRejectedValue(new Error('boom')));
        const result = await runTick({
            categories: [catA, catB],
            state: { aField: null, other: 'untouched', a_error: 'old', b_error: null },
            getToken: async () => 'TOK',
            now: () => 1000,
        });
        expect(result.changes).toEqual({ aField: 1, a_error: null, b_error: 'boom' });
        expect(result.state).toEqual({ aField: 1, other: 'untouched', a_error: null, b_error: 'boom' });
    });
    it('on an auth failure the changes are the error fields only', async () => {
        const cat = makeCat('a', 60000, jest.fn());
        const result = await runTick({
            categories: [cat],
            state: { aField: 'keep', a_error: null },
            getToken: async () => { throw new Error('auth boom'); },
            now: () => 1000,
        });
        expect(result.changes).toEqual({ a_error: 'Auth failed: auth boom' });
    });
    it('with nothing due there are no changes', async () => {
        const cat = makeCat('a', 60000, jest.fn());
        cat.lastPolled = Date.now();
        const result = await runTick({ categories: [cat], state: { x: 1 }, getToken: jest.fn(), now: Date.now });
        expect(result.changes).toEqual({});
    });
});

// Sweep 2026-10-08 #3: one auth failure used to mark every due category polled for its whole
// interval, update_check (which needs no token) included.
describe('runTick — auth failure backoff (1.6.2)', () => {
    const { isDue } = require('../lib/scheduler');
    const { AUTH_RETRY_BASE_MS, AUTH_RETRY_MAX_MS } = require('../lib/poll-tick');
    const HOUR = 60 * 60 * 1000;
    const failingToken = () => jest.fn().mockRejectedValue(new Error('KT-CT-1199: Too many requests'));

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-30T12:00:05Z'));
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it('a category that needs no token still runs when auth fails', async () => {
        const a = makeCat('a', HOUR, jest.fn());
        const upd = { ...makeCat('update_check', 24 * HOUR, jest.fn().mockResolvedValue({ latest_version: '9.9.9' })), needsToken: false };
        const result = await runTick({ categories: [a, upd], state: {}, getToken: failingToken(), now: Date.now });
        expect(a.poll).not.toHaveBeenCalled();
        expect(upd.poll).toHaveBeenCalledTimes(1);
        expect(upd.poll.mock.calls[0][0]).toBeUndefined();
        expect(result.state.latest_version).toBe('9.9.9');
        expect(result.state.update_check_error).toBeNull();
        expect(result.state.a_error).toMatch(/^Auth failed: KT-CT-1199/);
        expect(upd.lastPolled).toBe(Date.now());
    });

    it('asks for no token when only categories that need none are due', async () => {
        const upd = { ...makeCat('update_check', 24 * HOUR, jest.fn().mockResolvedValue({ x: 1 })), needsToken: false };
        const getToken = jest.fn();
        await runTick({ categories: [upd], state: {}, getToken, now: Date.now });
        expect(getToken).not.toHaveBeenCalled();
        expect(upd.poll).toHaveBeenCalledTimes(1);
    });

    it('after an auth failure a category is due again in 60 s, not every second and not a whole interval later', async () => {
        expect(AUTH_RETRY_BASE_MS).toBe(60000);
        const a = makeCat('a', HOUR, jest.fn().mockResolvedValue({ aField: 1 }));
        await runTick({ categories: [a], state: {}, getToken: failingToken(), now: Date.now });
        expect(isDue(a)).toBe(false);
        jest.advanceTimersByTime(59000);
        expect(isDue(a)).toBe(false);
        jest.advanceTimersByTime(1000);
        expect(isDue(a)).toBe(true);
    });

    it('the wait doubles on each failure in a row, up to a cap, and resets once auth works', async () => {
        const a = makeCat('a', 24 * HOUR, jest.fn().mockResolvedValue({ aField: 1 }));
        const waits = [];
        for (let i = 0; i < 7; i++) {
            const start = Date.now();
            await runTick({ categories: [a], state: {}, getToken: failingToken(), now: Date.now });
            let waited = 0;
            while (!isDue(a)) { jest.advanceTimersByTime(1000); waited += 1000; }
            waits.push(waited);
            expect(Date.now() - start).toBe(waited);
        }
        expect(waits.slice(0, 4)).toEqual([60000, 120000, 240000, 480000]);
        expect(Math.max(...waits)).toBe(AUTH_RETRY_MAX_MS);
        expect(AUTH_RETRY_MAX_MS).toBeLessThanOrEqual(10 * 60 * 1000);

        // Auth works: the category is polled and goes back to its normal interval.
        const result = await runTick({ categories: [a], state: {}, getToken: async () => 'TOK', now: Date.now });
        expect(a.poll).toHaveBeenCalledTimes(1);
        expect(result.state.a_error).toBeNull();
        expect(a.authRetryAt).toBeFalsy();
        jest.advanceTimersByTime(AUTH_RETRY_MAX_MS);
        expect(isDue(a)).toBe(false);

        // A later failure starts again at 60 s.
        jest.advanceTimersByTime(24 * HOUR);
        expect(isDue(a)).toBe(true);
        await runTick({ categories: [a], state: {}, getToken: failingToken(), now: Date.now });
        jest.advanceTimersByTime(59000);
        expect(isDue(a)).toBe(false);
        jest.advanceTimersByTime(1000);
        expect(isDue(a)).toBe(true);
    });

    it('a normal slot still comes first when it is sooner than the retry', async () => {
        const a = makeCat('a', 60000, jest.fn());
        jest.setSystemTime(new Date('2026-09-30T12:00:30Z'));
        await runTick({ categories: [a], state: {}, getToken: failingToken(), now: Date.now });
        jest.advanceTimersByTime(30000); // 12:01:00, the next 1-minute slot
        expect(isDue(a)).toBe(true);
    });

    it('a forced poll during auth stays due straight away', async () => {
        const a = makeCat('a', HOUR, jest.fn());
        const getToken = jest.fn(async () => { a.forceSeq = (a.forceSeq || 0) + 1; a.lastPolled = 0; throw new Error('auth boom'); });
        await runTick({ categories: [a], state: {}, getToken, now: Date.now });
        expect(isDue(a)).toBe(true);
    });
});

// Sweep 2026-10-08 #9: in a network blackhole every request waits 30 s, so an hourly tick
// with about 20 categories could run for 10 minutes. After the first network-level error the
// rest of the tick is skipped and left due for the next tick.
describe('runTick — stops after a network error (1.6.2)', () => {
    const ok = (field) => jest.fn().mockResolvedValue({ [field]: 1 });
    afterEach(() => { jest.useRealTimers(); });

    it.each([
        ['a time-out', new Error('Octopus API request timed out after 30s')],
        ['a dropped connection', new Error('Octopus API connection closed before a response arrived')],
        ['a socket error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
        ['an HTTP 503', new Error('HTTP 503: <html>Service Unavailable</html>')],
    ])('after %s the remaining Octopus categories wait for the next tick', async (_label, err) => {
        const a = makeCat('a', 60000, jest.fn().mockRejectedValue(err));
        const b = makeCat('b', 60000, ok('bField'));
        const c = makeCat('c', 60000, ok('cField'));
        const result = await runTick({ categories: [a, b, c], state: { b_error: 'old' }, getToken: async () => 'TOK', now: () => 1000 });
        expect(b.poll).not.toHaveBeenCalled();
        expect(c.poll).not.toHaveBeenCalled();
        expect(result.state.a_error).toBe(truncateText(err.message));
        expect(a.lastPolled).toBe(1000);
        // Still due, and their state is untouched.
        expect(b.lastPolled).toBe(0);
        expect(c.lastPolled).toBe(0);
        expect(result.state.b_error).toBe('old');
        expect(result.emitted).toBe(true);
    });

    it('a Kraken error or an HTTP 429 does not stop the tick', async () => {
        const kraken = makeCat('a', 60000, jest.fn().mockRejectedValue(
            Object.assign(new Error('KT-CT-4340: Unable to fetch planned dispatches'), { code: 'KT-CT-4340' })));
        const limited = makeCat('b', 60000, jest.fn().mockRejectedValue(new Error('HTTP 429')));
        const c = makeCat('c', 60000, ok('cField'));
        const result = await runTick({ categories: [kraken, limited, c], state: {}, getToken: async () => 'TOK', now: () => 1000 });
        expect(limited.poll).toHaveBeenCalledTimes(1);
        expect(c.poll).toHaveBeenCalledTimes(1);
        expect(result.state.cField).toBe(1);
    });

    it('categories that need no token still run, and their own network errors do not stop Octopus polls', async () => {
        const upd = { ...makeCat('update_check', 60000, jest.fn().mockRejectedValue(new Error('Request timed out after 30s'))), needsToken: false };
        const a = makeCat('a', 60000, ok('aField'));
        const down = makeCat('b', 60000, jest.fn().mockRejectedValue(new Error('Octopus API request timed out after 30s')));
        const upd2 = { ...makeCat('npm_two', 60000, ok('npmField')), needsToken: false };
        const c = makeCat('c', 60000, ok('cField'));
        await runTick({ categories: [upd, a, down, upd2, c], state: {}, getToken: async () => 'TOK', now: () => 1000 });
        expect(a.poll).toHaveBeenCalledTimes(1);
        expect(upd2.poll).toHaveBeenCalledTimes(1);
        expect(c.poll).not.toHaveBeenCalled();
    });

    it('the next tick goes on with the categories that were skipped', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-09-30T12:00:05Z'));
        const a = makeCat('a', 60000, jest.fn().mockRejectedValue(new Error('Octopus API request timed out after 30s')));
        const b = makeCat('b', 60000, ok('bField'));
        await runTick({ categories: [a, b], state: {}, getToken: async () => 'TOK', now: Date.now });
        expect(b.poll).not.toHaveBeenCalled();
        const result = await runTick({ categories: [a, b], state: {}, getToken: async () => 'TOK', now: Date.now });
        expect(a.poll).toHaveBeenCalledTimes(1);
        expect(b.poll).toHaveBeenCalledTimes(1);
        expect(result.state.bField).toBe(1);
    });
});

function truncateText(text) {
    return require('../lib/graphql-errors').truncate(text);
}

// Review 5 R6: when the watchdog starts a new tick, the old tick's results are dropped by the
// caller. What the old tick had polled must stay due, or it keeps stale data for an interval.
describe('runTick — a tick replaced by a newer one', () => {
    it('leaves the categories it polled due, so the newer tick polls them', async () => {
        let stale = false;
        const a = makeCat('rates', 3600000, jest.fn(async () => { stale = true; return { rates: 1 }; }));
        const b = makeCat('account', 3600000, jest.fn(async () => ({ balance: 2 })));
        await runTick({ categories: [a, b], state: {}, getToken: async () => 'TOK', now: () => 5000, isStale: () => stale });
        expect(a.poll).toHaveBeenCalledTimes(1);
        expect(b.poll).not.toHaveBeenCalled();
        expect(a.lastPolled).toBe(0);
        expect(b.lastPolled).toBe(0);
        expect(require('../lib/scheduler').isDue(a)).toBe(true);
    });

    it('marks every category polled when the tick ends current, each at its own poll time', async () => {
        let t = 1000;
        const a = makeCat('rates', 3600000, jest.fn(async () => { t = 2000; return {}; }));
        const b = makeCat('account', 3600000, jest.fn(async () => { t = 3000; return {}; }));
        await runTick({ categories: [a, b], state: {}, getToken: async () => 'TOK', now: () => t, isStale: () => false });
        expect(a.lastPolled).toBe(2000);
        expect(b.lastPolled).toBe(3000);
    });
});

// Network sweep F8: honour Retry-After on a rate-limited token request, capped at 10 minutes.
describe('runTick — a rate-limited token request', () => {
    const { AUTH_RETRY_BASE_MS, AUTH_RETRY_MAX_MS } = require('../lib/poll-tick');
    const fail = (retryAfterMs) => async () => { throw Object.assign(new Error('HTTP 429'), { retryAfterMs }); };

    it('waits for Retry-After when it is longer than the back-off', async () => {
        const a = makeCat('rates', 3600000, jest.fn());
        await runTick({ categories: [a], state: {}, getToken: fail(120000), now: () => 1000 });
        expect(a.authRetryAt).toBe(1000 + 120000);
    });

    it('keeps the back-off when Retry-After is shorter, and caps a long one at 10 minutes', async () => {
        const a = makeCat('rates', 3600000, jest.fn());
        await runTick({ categories: [a], state: {}, getToken: fail(5000), now: () => 1000 });
        expect(a.authRetryAt).toBe(1000 + AUTH_RETRY_BASE_MS);
        const b = makeCat('account', 3600000, jest.fn());
        await runTick({ categories: [b], state: {}, getToken: fail(86400000), now: () => 1000 });
        expect(b.authRetryAt).toBe(1000 + AUTH_RETRY_MAX_MS);
    });
});
