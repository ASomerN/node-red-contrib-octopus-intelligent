// __tests__/lib-small-edges.test.js
'use strict';
/**
 * Coverage sweep 2 (v1.7): small branches in lib/ helpers that the module tests skip.
 */
const { compareSemver, checkUpdate } = require('../lib/update-check');
const { createApiMetrics } = require('../lib/api-metrics');
const { planCommands } = require('../lib/commands');
const { truncate } = require('../lib/graphql-errors');

describe('compareSemver edges', () => {
    test('an unparseable version compares equal (no update offered on junk)', () => {
        expect(compareSemver('latest', '1.6.1')).toBe(0);
        expect(compareSemver('1.6.1', '1.6')).toBe(0);
    });

    test('two pre-releases of the same base compare equal', () => {
        expect(compareSemver('1.7.0-dev.1', '1.7.0-dev.2')).toBe(0);
    });
});

describe('checkUpdate edges', () => {
    test('a null registry body is reported as a missing version', async () => {
        const httpGetJson = jest.fn().mockResolvedValue(null);
        await expect(checkUpdate(httpGetJson, '1.6.1')).rejects.toThrow('npm registry response missing version');
    });

    test('a version string that is not X.Y.Z is reported as a missing version', async () => {
        const httpGetJson = jest.fn().mockResolvedValue({ version: 'v1.7' });
        await expect(checkUpdate(httpGetJson, '1.6.1')).rejects.toThrow('npm registry response missing version');
    });
});

describe('createApiMetrics edges', () => {
    test('a poll recorded without a complexity counts as a request with complexity 0', () => {
        const metrics = createApiMetrics();
        metrics.recordPoll();
        expect(metrics.getMetrics()).toEqual({ requests_last_hour: 1, complexity_last_hour: 0, complexity_percent: '0.0' });
    });
});

describe('planCommands value display edges', () => {
    test('a set_boost value that cannot be JSON-encoded (circular) is still shown in the error', () => {
        const v = {};
        v.self = v;
        const plan = planCommands({ set_boost: v }, { confirmedLimit: 80, confirmedTime: '08:00' });
        expect(plan.actions).toEqual([]);
        expect(plan.errors).toEqual(["Invalid set_boost '[object Object]' — must be true or false"]);
        expect(plan.hasCommand).toBe(true);
    });

    // Since 1.6.2 set_timezone is validated: a non-string value is an error, not silently ignored.
    test('a non-string set_timezone is an error and changes nothing', () => {
        const plan = planCommands({ set_timezone: 42 }, { confirmedLimit: 80, confirmedTime: '08:00' });
        expect(plan.actions).toEqual([]);
        expect(plan.errors).toHaveLength(1);
        expect(plan.hasCommand).toBe(true);
    });
});

describe('truncate edges', () => {
    test('a custom maximum cuts with an ellipsis inside the limit', () => {
        expect(truncate('abcdefghij', 8)).toBe('abcde...');
        expect(truncate('abcdefgh', 8)).toBe('abcdefgh');
    });

    test('non-string input is stringified', () => {
        expect(truncate(12345)).toBe('12345');
        expect(truncate(null)).toBe('null');
    });
});
