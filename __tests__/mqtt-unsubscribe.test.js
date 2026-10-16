// __tests__/mqtt-unsubscribe.test.js
'use strict';
/**
 * Code review 2026-10-06 (F11, "F3" in review-findings.test.js): MQTT command subscriptions
 * were never removed on close. unsubscribe() got all seven topics as arguments (only the first
 * is a topic; the second became the ref) and deregister() was never called, so after a partial
 * redeploy every Home Assistant command ran twice.
 * Node-RED broker API: subscribe(topic, options, callback, ref),
 * unsubscribe(topic, ref, removeClientSubscription), deregister(node, done, autoDisconnect).
 */
describe('F3: MQTT command subscriptions are removed properly on close', () => {
    function buildNodeWithBroker(broker) {
        let NodeCtor = null;
        const RED = {
            nodes: {
                // Node-RED's createNode copies config.id onto the node.
                createNode(node, config) {
                    const handlers = {};
                    const store = {};
                    node.id = config.id;
                    node._handlers = handlers;
                    node.credentials = { apiKey: 'sk_test_mqtt' };
                    node.on = (evt, fn) => { handlers[evt] = fn; };
                    node.log = () => {}; node.warn = () => {}; node.error = () => {};
                    node.status = () => {}; node.send = () => {};
                    node.context = () => ({ get: (k) => store[k], set: (k, v) => { store[k] = v; } });
                },
                getNode: () => broker,
                registerType: (type, ctor) => { NodeCtor = ctor; },
            },
        };
        jest.isolateModules(() => { require('../octopus-intelligent.js')(RED); });
        return new NodeCtor({ id: 'oi-mqtt', accountNumber: 'A-MQTT0001', enableMqtt: true, broker: 'b1', refreshInterval: 5 });
    }

    function makeBroker() {
        return {
            client: null,
            register: jest.fn(),
            deregister: jest.fn((node, done) => done && done()),
            subscribe: jest.fn(),
            unsubscribe: jest.fn(),
            publish: jest.fn(),
        };
    }

    beforeEach(() => {
        jest.useFakeTimers();
        jest.doMock('../lib/graphql', () => ({ graphqlPost: jest.fn(async () => ({ data: { errors: [{ message: 'stubbed' }] }, status: 200, headers: {} })) }));
        jest.doMock('../lib/http-get-json', () => jest.fn(async () => { throw new Error('stubbed'); }));
        jest.doMock('../lib/discovery', () => ({ discoverProducts: jest.fn(() => new Promise(() => {})), parseDiscovery: jest.fn() }));
    });
    afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.resetModules(); });

    test('each command topic is unsubscribed with this node as the ref, and the node deregisters', () => {
        const broker = makeBroker();
        const node = buildNodeWithBroker(broker);
        const topics = broker.subscribe.mock.calls.map((c) => c[0]);
        expect(topics.length).toBe(8); // v1.7 adds set_boost
        node._handlers.close(() => {});
        for (const t of topics) {
            expect(broker.unsubscribe).toHaveBeenCalledWith(t, 'oi-mqtt', expect.anything());
        }
        expect(broker.deregister).toHaveBeenCalled();
    });

    test('each command topic is subscribed with this node as the ref', () => {
        const broker = makeBroker();
        const node = buildNodeWithBroker(broker);
        try {
            expect(broker.subscribe).toHaveBeenCalledTimes(8);
            for (const call of broker.subscribe.mock.calls) {
                expect(typeof call[2]).toBe('function');
                expect(call[3]).toBe('oi-mqtt');
            }
        } finally {
            node._handlers.close(false, () => {});
        }
    });

    test('close called by Node-RED as (removed, done) unsubscribes each topic once, deregisters and calls done', () => {
        const broker = makeBroker();
        const node = buildNodeWithBroker(broker);
        const done = jest.fn();
        node._handlers.close(true, done);
        expect(broker.unsubscribe).toHaveBeenCalledTimes(8);
        for (const call of broker.unsubscribe.mock.calls) {
            expect(call).toEqual([expect.any(String), 'oi-mqtt', true]);
        }
        expect(broker.deregister).toHaveBeenCalledTimes(1);
        expect(broker.deregister.mock.calls[0][0]).toBe(node);
        expect(done).toHaveBeenCalledTimes(1);
    });

    test('close still calls done when MQTT is disabled', () => {
        const broker = makeBroker();
        let NodeCtor = null;
        const RED = {
            nodes: {
                createNode(n, config) {
                    n.id = config.id;
                    n._handlers = {};
                    n.credentials = { apiKey: 'sk_test_mqtt' };
                    n.on = (evt, fn) => { n._handlers[evt] = fn; };
                    n.log = () => {}; n.warn = () => {}; n.error = () => {};
                    n.status = () => {}; n.send = () => {};
                    n.context = () => ({ get: () => undefined, set: () => {} });
                },
                getNode: () => null,
                registerType: (type, ctor) => { NodeCtor = ctor; },
            },
        };
        jest.isolateModules(() => { require('../octopus-intelligent.js')(RED); });
        const node = new NodeCtor({ id: 'oi-nomqtt', accountNumber: 'A-MQTT0002', enableMqtt: false, refreshInterval: 5 });
        const done = jest.fn();
        node._handlers.close(false, done);
        expect(done).toHaveBeenCalledTimes(1);
        expect(broker.deregister).not.toHaveBeenCalled();
    });
});
