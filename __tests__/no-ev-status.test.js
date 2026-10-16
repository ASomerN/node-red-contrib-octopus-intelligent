// __tests__/no-ev-status.test.js
'use strict';
/**
 * Observability 2026-10-09: on an account with no car or charger the node status stayed the
 * green "Confirmed" default while every Octopus poll failed. It now shows the first poll
 * error: red when every Octopus poll failed, yellow when only some did. Accounts with a
 * charger keep the charging status as before. Kraken answers HTTP 200 with GraphQL errors.
 */
jest.mock('../lib/graphql', () => ({ graphqlPost: jest.fn() }));
jest.mock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
jest.mock('../lib/discovery', () => ({ discoverProducts: jest.fn(), parseDiscovery: jest.fn() }));
jest.mock('../lib/scheduler', () => ({ ...jest.requireActual('../lib/scheduler'), createScheduler: jest.fn() }));

const { graphqlPost } = require('../lib/graphql');
const { discoverProducts } = require('../lib/discovery');
const { createHarness, DISCOVERED } = require('./helpers/real-node');

const NO_EV = { ...DISCOVERED, hasIntelligent: false, deviceId: null, deviceSuspended: null, deviceCount: 1 };
const UNAUTHORIZED = { errors: [{ message: 'Unauthorized.', path: ['account'], extensions: { errorType: 'AUTHORIZATION', errorCode: 'KT-CT-1111' } }], data: null };

const SAVING_SESSIONS_OK = () => ({
    data: { savingSessions: { events: [], account: { hasJoinedCampaign: false, joinedEvents: [] } } },
});

let h;
let replies; // per operation name: () => body, or undefined for the harness default

const lastStatus = () => h.statuses[h.statuses.length - 1];

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T12:00:10Z'));
    h = createHarness();
    replies = {};
    const base = graphqlPost.getMockImplementation();
    graphqlPost.mockImplementation(async (body, token, host) => {
        for (const op of Object.keys(replies)) {
            if (body.query.includes(op)) return { data: replies[op](), status: 200 };
        }
        return base(body, token, host);
    });
});

afterEach(() => {
    h.close();
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('no charger and every Octopus poll failing: red status with the first error', async () => {
    discoverProducts.mockResolvedValue(NO_EV);
    replies.getSavingSessions = () => UNAUTHORIZED;
    replies.getAccountBalance = () => UNAUTHORIZED;
    replies.getOctoplusInfo = () => UNAUTHORIZED;
    await h.start();

    expect(lastStatus()).toEqual({ fill: 'red', shape: 'ring', text: 'saving_sessions: KT-CT-1111: Unauthorized' });
});

test('no charger and some Octopus polls failing: yellow status with the first error', async () => {
    discoverProducts.mockResolvedValue(NO_EV);
    replies.getSavingSessions = SAVING_SESSIONS_OK;
    replies.getAccountBalance = () => UNAUTHORIZED;
    replies.getOctoplusInfo = () => ({ data: { octoplusAccountInfo: { enrollmentStatus: 'ENROLLED', isLoyaltyPointsUser: true } } });
    await h.start();

    expect(lastStatus()).toEqual({ fill: 'yellow', shape: 'ring', text: 'account: KT-CT-1111: Unauthorized' });
});

test('no charger and a failed update check only: the status stays green', async () => {
    discoverProducts.mockResolvedValue(NO_EV);
    replies.getSavingSessions = SAVING_SESSIONS_OK;
    replies.getAccountBalance = () => ({ data: { account: { balance: 12345 } } });
    replies.getOctoplusInfo = () => ({ data: { octoplusAccountInfo: { enrollmentStatus: 'ENROLLED', isLoyaltyPointsUser: true } } });
    await h.start();

    expect(h.pollSends().pop().payload.update_check_error).toBeTruthy(); // npm is not Octopus
    expect(lastStatus().fill).toBe('green');
});

test('a long error is cut for the editor', async () => {
    discoverProducts.mockResolvedValue(NO_EV);
    const long = { errors: [{ message: 'z'.repeat(400), path: ['account'], extensions: { errorCode: 'KT-CT-1111' } }], data: null };
    replies.getSavingSessions = () => long;
    replies.getAccountBalance = () => long;
    replies.getOctoplusInfo = () => long;
    await h.start();

    expect(lastStatus().fill).toBe('red');
    expect(lastStatus().text.length).toBeLessThanOrEqual(80);
});

test('with a charger the charging status is unchanged: another poll failing keeps it green', async () => {
    replies.getSavingSessions = () => UNAUTHORIZED;
    await h.start();

    expect(h.pollSends().pop().payload.saving_sessions_error).toBe('KT-CT-1111: Unauthorized');
    expect(lastStatus()).toEqual({ fill: 'green', shape: 'dot', text: 'Confirmed: 90% @ 04:00' });
});
