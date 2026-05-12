'use strict';
const { createApiMetrics } = require('../lib/api-metrics');

describe('createApiMetrics', () => {
    test('returns zero counts when no polls recorded', () => {
        const metrics = createApiMetrics();
        expect(metrics.getMetrics()).toEqual({
            requests_last_hour: 0,
            complexity_last_hour: 0,
            complexity_percent: '0.0'
        });
    });

    test('counts polls within last hour', () => {
        const metrics = createApiMetrics();
        metrics.recordPoll(300);
        metrics.recordPoll(250);
        const result = metrics.getMetrics();
        expect(result.requests_last_hour).toBe(2);
        expect(result.complexity_last_hour).toBe(550);
    });

    test('excludes polls older than 60 minutes', () => {
        const metrics = createApiMetrics();
        const old = Date.now() - 61 * 60 * 1000;
        metrics._history.push({ timestamp: old, complexity: 999 });
        metrics.recordPoll(100);
        const result = metrics.getMetrics();
        expect(result.requests_last_hour).toBe(1);
        expect(result.complexity_last_hour).toBe(100);
    });

    test('calculates complexity percent against 50000 limit', () => {
        const metrics = createApiMetrics();
        metrics.recordPoll(25000);
        const result = metrics.getMetrics();
        expect(result.complexity_percent).toBe('50.0');
    });
});
