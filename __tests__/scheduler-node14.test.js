// __tests__/scheduler-node14.test.js
'use strict';
/**
 * package.json allows Node >= 14, where `performance` is not a global (it is from Node 16).
 * The scheduler's monotonic clock must not depend on the global.
 */
describe('scheduler without a global performance (Node 14/15)', () => {
    const saved = global.performance;

    afterEach(() => {
        global.performance = saved;
        jest.resetModules();
    });

    test('the in-flight guard still runs the tick', async () => {
        delete global.performance;
        jest.resetModules();
        const { wrapWithInFlightGuard } = require('../lib/scheduler');
        const fn = jest.fn().mockResolvedValue(undefined);
        const guarded = wrapWithInFlightGuard(fn);
        await guarded();
        await guarded();
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
