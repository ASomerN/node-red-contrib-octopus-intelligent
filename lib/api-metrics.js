'use strict';
const HOURLY_LIMIT = 50000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function createApiMetrics() {
    const history = [];

    function recordPoll(complexity) {
        history.push({ timestamp: Date.now(), complexity: complexity || 0 });
        pruneOld();
    }

    function pruneOld() {
        const cutoff = Date.now() - ONE_HOUR_MS;
        while (history.length > 0 && history[0].timestamp < cutoff) history.shift();
    }

    function getMetrics() {
        pruneOld();
        const total = history.reduce((sum, e) => sum + e.complexity, 0);
        return {
            requests_last_hour: history.length,
            complexity_last_hour: total,
            complexity_percent: ((total / HOURLY_LIMIT) * 100).toFixed(1)
        };
    }

    return { recordPoll, getMetrics, _history: history };
}

module.exports = { createApiMetrics };
