// __tests__/examples.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { TIME_OPTIONS, validateTime } = require('../lib/preferences');

const EXAMPLES = path.join(__dirname, '..', 'examples');
const flow = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'node-red-dashboard-flow.json'), 'utf8'));
const byId = new Map(flow.map((n) => [n.id, n]));
const yamlLines = fs.readFileSync(path.join(EXAMPLES, 'ha-dashboard.yaml'), 'utf8').split(/\r?\n/);

// Runs a function node's body the way Node-RED does for these simple examples.
const runFunctionNode = (node, msg) => new Function('msg', node.func)(msg);
const targets = (node) => (node.wires || []).flat();

describe('Dashboard 2.0 example flow', () => {
    test('node ids are unique and every wire points at an existing node', () => {
        expect(byId.size).toBe(flow.length);
        const dangling = flow.flatMap((n) => targets(n).filter((t) => !byId.has(t)).map((t) => `${n.id} -> ${t}`));
        expect(dangling).toEqual([]);
    });

    test('"Ready by" dropdown offers exactly TIME_OPTIONS, label = value, all accepted by the node', () => {
        const dropdowns = flow.filter((n) => n.type === 'ui-dropdown' && n.label === 'Ready by');
        expect(dropdowns).toHaveLength(1);
        const options = dropdowns[0].options;
        expect(options.map((o) => o.value)).toEqual(TIME_OPTIONS);
        options.forEach((o) => expect(o.label).toBe(o.value));
        options.forEach((o) => expect(validateTime(o.value).ok).toBe(true));
    });

    test('Charge Cap ui-switch sits right after Smart Charging in EV Charging Controls', () => {
        const smart = byId.get('widget-controls-smart');
        const caps = flow.filter((n) => n.type === 'ui-switch' && n.label === 'Charge Cap');
        expect(caps).toHaveLength(1);
        expect(caps[0].group).toBe('ui-group-controls-ev');
        expect(caps[0].group).toBe(smart.group);
        expect(caps[0].order).toBe(smart.order + 1);
    });

    test('Charge Cap switch output reaches the node as { set_charge_cap: <bool> }', () => {
        const cap = flow.find((n) => n.type === 'ui-switch' && n.label === 'Charge Cap');
        const fnIds = targets(cap);
        expect(fnIds).toHaveLength(1);
        const fn = byId.get(fnIds[0]);
        expect(fn.type).toBe('function');
        expect(targets(fn)).toEqual(['node-octopus-main']);
        expect(byId.get('node-octopus-main').type).toBe('octopus-intelligent');
        expect(runFunctionNode(fn, { payload: true }).payload).toEqual({ set_charge_cap: true });
        expect(runFunctionNode(fn, { payload: false }).payload).toEqual({ set_charge_cap: false });
    });

    test('Charge Cap switch state follows payload.charge_cap and never echoes back as a command', () => {
        const cap = byId.get('widget-controls-charge-cap');
        expect(cap.passthru).toBe(false);
        const feeder = byId.get('fn-controls-charge-cap-state');
        expect(targets(byId.get('fn-route-pages'))).toContain('fn-controls-charge-cap-state');
        expect(targets(feeder)).toEqual(['widget-controls-charge-cap']);
        expect(runFunctionNode(feeder, { payload: { charge_cap: true } })).toEqual({ payload: true });
        expect(runFunctionNode(feeder, { payload: { charge_cap: false } })).toEqual({ payload: false });
        expect(runFunctionNode(feeder, { payload: { charge_cap: null } })).toBeNull();
        expect(runFunctionNode(feeder, { payload: {} })).toBeNull();
    });
});

describe('HA dashboard example', () => {
    test('controls card lists the Charge Cap switch right after Smart Charging, same indentation', () => {
        const smartLine = '          - entity: switch.octopus_intelligent_smart_charging';
        const i = yamlLines.indexOf(smartLine);
        expect(i).toBeGreaterThan(-1);
        const nextEntity = yamlLines.slice(i + 1).find((l) => l.trim().startsWith('- entity:'));
        expect(nextEntity).toBe('          - entity: switch.octopus_intelligent_charge_cap');
        const capIndex = yamlLines.indexOf(nextEntity);
        expect(yamlLines[capIndex + 1]).toBe('            name: Charge Cap');
    });
});
