'use strict';
const { graphqlPost } = require('./lib/graphql');
const { onlyDeviceFieldErrors, graphqlError, errorCode, truncate, maskSecretsDeep, isUnconfirmedWriteError } = require('./lib/graphql-errors');

// Kraken: "Your device charging preferences could not be fetched" (devices.preferences).
const PREFERENCES_ERROR_CODE = 'KT-CT-4339';
// Device fields of the charging poll whose errors are tolerated (aliases in DEVICES_QUERY).
const TOLERATED_DEVICE_FIELDS = ['preferences', 'chargeCap', 'smartStatus'];
const { convertToTimezone, resolveTimezone, validateTimezone } = require('./lib/timezone');
const { createApiMetrics } = require('./lib/api-metrics');
const intelligentCategory = require('./lib/categories/intelligent');
const { buildDefaultPayload } = require('./lib/payload');
const { createScheduler } = require('./lib/scheduler');
const { retryDelay, isRetryable, nextSlotStart, createRateWindow, formatDuration } = require('./lib/poll-retry');
const { discoveryRetryDelay, EMPTY_DEVICES_MAX_RETRIES } = require('./lib/discovery-retry');
const { simplePoll, runTick } = require('./lib/poll-tick');
const { discoverProducts } = require('./lib/discovery');
const { mergePayload } = require('./lib/payload');
const electricityCategory = require('./lib/categories/electricity');
const gasCategory = require('./lib/categories/gas');
const wheelOfFortuneCategory = require('./lib/categories/wheel-of-fortune');
const homeMiniCategory = require('./lib/categories/home-mini');
const completedDispatchesCategory = require('./lib/categories/completed-dispatches');
const accountCategory = require('./lib/categories/account');
const octoplusCategory = require('./lib/categories/octoplus');
const flexPlannedDispatchesCategory = require('./lib/categories/flex-planned-dispatches');
const applicableRatesCategory = require('./lib/categories/applicable-rates');
const savingSessionsCategory = require('./lib/categories/saving-sessions');
const freeElectricityCategory = require('./lib/categories/free-electricity');
const smartflexVehicleCategory = require('./lib/categories/smartflex-vehicle');
const smartflexInverterCategory = require('./lib/categories/smartflex-inverter');
const httpGetJson = require('./lib/http-get-json');
const { TIME_OPTIONS, validateTime, validateLimit } = require('./lib/preferences');
const { planCommands } = require('./lib/commands');
const { buildBoostRequest, parseBoostResponse, chargingNowFor, reconcileChargingNow } = require('./lib/boost');
const { checkUpdate } = require('./lib/update-check');
const {
    sensors, errorSensors, vehicleSensors, vehicleErrorSensors, inverterSensors, inverterErrorSensors,
} = require('./lib/sensor-definitions');
const { changedActiveFields } = require('./lib/active-now');

module.exports = function (RED) {
    function OctopusIntelligentNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // 1. Configuration
        const account = config.accountNumber ? config.accountNumber.trim() : "";
        const apiKey = this.credentials.apiKey ? this.credentials.apiKey.trim() : "";

        // Kraken error text can echo the request, API key included. The Node-RED log, status and
        // msg show it as it is, so a wrong key can be seen. Keys and tokens are masked only in
        // what is published to Home Assistant (stateJson), where they would be kept in its history.
        // A log line is at most MAX_LOG_LENGTH characters. An over-long line keeps its start and
        // its end (". Retrying in 30s."); error text embedded in a line is cut to 300 characters
        // first (short), so normally nothing is cut here.
        const MAX_LOG_LENGTH = 500;
        const capLine = (m) => (m.length > MAX_LOG_LENGTH ? `${m.slice(0, 380)} ... ${m.slice(-(MAX_LOG_LENGTH - 385))}` : m);
        const clean = (m) => (typeof m === 'string' ? capLine(m) : m);
        const short = (m) => truncate(m, 300);
        // The JSON published to the MQTT state topic, with keys and tokens masked.
        const stateJson = (state) => JSON.stringify(maskSecretsDeep(state, [apiKey]));
        const rawLog = node.log, rawWarn = node.warn, rawError = node.error, rawStatus = node.status;
        node.log = function (m, ...rest) { return rawLog.call(node, clean(m), ...rest); };
        node.warn = function (m, ...rest) { return rawWarn.call(node, clean(m), ...rest); };
        node.error = function (m, ...rest) { return rawError.call(node, clean(m), ...rest); };
        node.status = function (s, ...rest) {
            const masked = s && typeof s === 'object' && typeof s.text === 'string' ? Object.assign({}, s, { text: clean(s.text) }) : clean(s);
            return rawStatus.call(node, masked, ...rest);
        };
        const refreshRate = (config.refreshInterval || 5) * 60 * 1000;
        const enableMqtt = config.enableMqtt;
        node.timezoneOverride = config.timezoneOverride || "";

        // MQTT Topics
        this.broker = RED.nodes.getNode(config.broker);
        const mqttPrefix = `homeassistant`;
        const uniqueIdPrefix = `nodered_${account}`;
        const stateTopic = `nodered_octopus/${account}/status`;

        // Command Topics (For listening)
        const cmdTopicLimit = `nodered_octopus/${account}/set_limit`;
        const cmdTopicTime = `nodered_octopus/${account}/set_time`;
        const cmdTopicSubmit = `nodered_octopus/${account}/submit_changes`;
        const cmdTopicRefresh = `nodered_octopus/${account}/refresh`;
        const cmdTopicTimezone = `nodered_octopus/${account}/set_timezone`;
        const cmdTopicSmartCharging = `nodered_octopus/${account}/set_smart_charging`;
        const cmdTopicChargeCap = `nodered_octopus/${account}/set_charge_cap`;
        const cmdTopicBoost = `nodered_octopus/${account}/set_boost`;
        const commandTopics = [cmdTopicLimit, cmdTopicTime, cmdTopicSubmit, cmdTopicRefresh,
            cmdTopicTimezone, cmdTopicSmartCharging, cmdTopicChargeCap, cmdTopicBoost];

        // 2. Constants & Validation — TIME_OPTIONS / validators live in lib/preferences.js

        // 3. Sensor Definitions (Read-Only) — imported from lib/sensor-definitions.js

        // 4. Helper: Announce Controls (Write-Enabled)
        // Single Home Assistant device: every entity sits on it (never split).
        const device = {
            identifiers: [`nodered_octopus_${account}`],
            name: "Octopus Intelligent",
            manufacturer: "Octopus Energy",
            model: "Intelligent Octopus Go",
            // The package version (review L5). Not part of any unique_id, so no entity moves.
            sw_version: require('./package.json').version,
            suggested_area: "Energy",
            configuration_url: "https://octopus.energy/intelligent/"
        };

        // Review A3: the 1.7 SmartFlex fields are missing from the state JSON of an older version
        // (after a rollback, which never clears these retained configs) and from a retained 1.6
        // state read before the first 1.7 poll. Their templates check `is defined`, so Home
        // Assistant logs no template warnings and shows no false Problem.
        // Review L1: a template that renders None gives unknown only on a numeric sensor (unit,
        // state_class or numeric device_class) and on binary sensors. A text sensor stores the
        // text "None". So every SmartFlex entity also gets an availability check on the state
        // topic: a missing field reads Unavailable. Text sensors marked nullUnavailable also read
        // Unavailable when the field is null (HA has no way to show unknown for a text sensor).
        const valueOrNone = (field) => `value_json.${field} if value_json.${field} is defined else None`;
        const listOrEmpty = (field) => `(value_json.${field} if value_json.${field} is defined else [])`;
        const fieldAvailability = (field, nullUnavailable) => [{
            topic: stateTopic,
            value_template: nullUnavailable === true
                ? `{{ 'online' if value_json.${field} is defined and value_json.${field} is not none else 'offline' }}`
                : `{{ 'online' if value_json.${field} is defined else 'offline' }}`,
        }];

        // Read-only sensor discovery config (definitions in lib/sensor-definitions.js).
        // missingSafe: the field may be missing from the state JSON (SmartFlex, review A3).
        function announceSensor(sensor, missingSafe) {
            const payload = {
                name: `Octopus ${sensor.name}`,
                unique_id: `${uniqueIdPrefix}_${sensor.id}`,
                state_topic: stateTopic,
                value_template: missingSafe === true ? `{{ ${valueOrNone(sensor.val)} }}` : `{{ value_json.${sensor.val} }}`,
                device: device
            };
            if (sensor.class) payload.device_class = sensor.class;
            if (sensor.unit) payload.unit_of_measurement = sensor.unit;
            if (sensor.stateClass) payload.state_class = sensor.stateClass;
            if (sensor.icon) payload.icon = sensor.icon;
            if (missingSafe === true) payload.availability = fieldAvailability(sensor.val, sensor.nullUnavailable);

            if (sensor.category) {
                payload.entity_category = sensor.category;
            }

            if (sensor.id === 'applicable_rates_count') {
                payload.json_attributes_topic = stateTopic;
                payload.json_attributes_template = '{ "rates": {{ value_json.applicable_rates | tojson }} }';
            } else if (sensor.id === 'electricity_export_rate_count') {
                payload.json_attributes_topic = stateTopic;
                payload.json_attributes_template = '{ "rates": {{ value_json.electricity_export_rate | tojson }} }';
            } else if (sensor.id === 'last_session_kwh') {
                // v1.7.0: the full SmartFlex session list and device alerts go in attributes only.
                payload.json_attributes_topic = stateTopic;
                payload.json_attributes_template = `{ "sessions": {{ ${listOrEmpty('charging_sessions')} | tojson }}, "alerts": {{ ${listOrEmpty('device_alerts')} | tojson }} }`;
                // state_class total (review L2): the energy counts from a new cycle at each session
                // end, so HA adds each finished session's kWh to the statistics once. last_session
                // is always a finished session (it has an end). An empty string is ignored by HA:
                // no session yet, or the state JSON of an older version.
                payload.last_reset_value_template = "{{ value_json.last_session.end if value_json.last_session is defined and value_json.last_session and value_json.last_session.end else '' }}";
            }

            node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_${sensor.id}/config`, JSON.stringify(payload), { retain: true });
        }

        // v1.5 — error binary_sensor discovery config (device_class: problem).
        // missingSafe: a missing field reads OFF, not ON (review A3: Jinja's Undefined is not
        // in [None, ''], so the 1.5 template shows a false Problem when the field is missing).
        function announceErrorSensor(e, missingSafe) {
            const payload = {
                name: `Octopus ${e.name}`,
                unique_id: `${uniqueIdPrefix}_${e.id}`,
                state_topic: stateTopic,
                value_template: missingSafe === true
                    ? `{{ 'ON' if value_json.${e.val} is defined and value_json.${e.val} not in [None, ''] else 'OFF' }}`
                    : `{{ 'OFF' if value_json.${e.val} in [None, ''] else 'ON' }}`,
                payload_on: 'ON',
                payload_off: 'OFF',
                device_class: 'problem',
                entity_category: 'diagnostic',
                device: device,
            };
            if (missingSafe === true) payload.availability = fieldAvailability(e.val);
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_${e.id}/config`, JSON.stringify(payload), { retain: true });
        }

        function announceControls() {
            if (!enableMqtt || !node.broker) return;

            // A. The Slider (Number) - now shows pending value
            const limitConfig = {
                name: "Octopus Target Charge",
                unique_id: `${uniqueIdPrefix}_target_limit`,
                state_topic: stateTopic,
                command_topic: cmdTopicLimit,
                value_template: "{{ value_json.pending_limit }}",
                min: 5, max: 100, step: 5,
                unit_of_measurement: "%",
                icon: "mdi:battery-charging-high",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/number/${uniqueIdPrefix}_limit/config`, JSON.stringify(limitConfig), { retain: true });

            // B. The Dropdown (Select) - now shows pending value
            const timeConfig = {
                name: "Octopus Ready Time",
                unique_id: `${uniqueIdPrefix}_target_time`,
                state_topic: stateTopic,
                command_topic: cmdTopicTime,
                value_template: "{{ value_json.pending_time }}",
                options: TIME_OPTIONS,
                icon: "mdi:clock-time-four-outline",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/select/${uniqueIdPrefix}_time/config`, JSON.stringify(timeConfig), { retain: true });

            // C. Submit Button
            const buttonConfig = {
                name: "Octopus Apply Changes",
                unique_id: `${uniqueIdPrefix}_submit_button`,
                command_topic: cmdTopicSubmit,
                payload_press: "SUBMIT",
                icon: "mdi:check-circle",
                device_class: "update",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/button/${uniqueIdPrefix}_submit/config`, JSON.stringify(buttonConfig), { retain: true });

            // D. Refresh Button
            const refreshButtonConfig = {
                name: "Octopus Refresh API",
                unique_id: `${uniqueIdPrefix}_refresh_button`,
                command_topic: cmdTopicRefresh,
                payload_press: "REFRESH",
                icon: "mdi:refresh",
                device_class: "restart",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/button/${uniqueIdPrefix}_refresh/config`, JSON.stringify(refreshButtonConfig), { retain: true });

            // E. Add sensors for confirmed values (read-only display)
            const confirmedLimitSensor = {
                name: "Octopus Confirmed Charge Limit",
                unique_id: `${uniqueIdPrefix}_confirmed_limit`,
                state_topic: stateTopic,
                value_template: "{{ value_json.confirmed_limit }}",
                unit_of_measurement: "%",
                icon: "mdi:battery-check",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_confirmed_limit/config`, JSON.stringify(confirmedLimitSensor), { retain: true });

            const confirmedTimeSensor = {
                name: "Octopus Confirmed Ready Time",
                unique_id: `${uniqueIdPrefix}_confirmed_time`,
                state_topic: stateTopic,
                value_template: "{{ value_json.confirmed_time }}",
                icon: "mdi:clock-check",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_confirmed_time/config`, JSON.stringify(confirmedTimeSensor), { retain: true });

            // G. Charging Now Binary Sensor (main sensor for automations)
            const chargingNowBinarySensor = {
                name: "Octopus Charging Now",
                unique_id: `${uniqueIdPrefix}_charging_now`,
                state_topic: `${stateTopic}/charging_now`,
                device_class: "battery_charging",
                payload_on: "ON",
                payload_off: "OFF",
                icon: "mdi:ev-station",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_charging_now/config`, JSON.stringify(chargingNowBinarySensor), { retain: true });

            // G2. Saving Session Available Binary Sensor
            const savingSessionBinarySensor = {
                name: "Octopus Saving Session Available",
                unique_id: `${uniqueIdPrefix}_saving_session_available`,
                state_topic: stateTopic,
                value_template: "{{ value_json.saving_session_available }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:lightning-bolt-circle",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_saving_session_available/config`, JSON.stringify(savingSessionBinarySensor), { retain: true });

            // G2a. Saving Session Window Active Binary Sensor (v1.3.3)
            const savingSessionWindowActiveSensor = {
                name: "Octopus Saving Session Window Active",
                unique_id: `${uniqueIdPrefix}_saving_session_window_active`,
                state_topic: stateTopic,
                value_template: "{{ value_json.saving_session_window_active }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:clock-check-outline",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_saving_session_window_active/config`, JSON.stringify(savingSessionWindowActiveSensor), { retain: true });

            // G2b. Saving Session Active Binary Sensor (v1.3.3) — joined AND in window
            const savingSessionActiveSensor = {
                name: "Octopus Saving Session Active",
                unique_id: `${uniqueIdPrefix}_saving_session_active`,
                state_topic: stateTopic,
                value_template: "{{ value_json.saving_session_active }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:home-export-outline",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_saving_session_active/config`, JSON.stringify(savingSessionActiveSensor), { retain: true });

            // G2c. v1.3.3 migration: delete the deprecated sensor.saving_session_joined
            // entity. HA's sensor domain doesn't render booleans cleanly. Empty
            // payload on the discovery topic with retain tells HA the entity no
            // longer exists. Safe to keep across releases.
            node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_saving_session_joined/config`, "", { retain: true });

            // G2d. Saving Session Joined Binary Sensor (v1.3.3 migration)
            const savingSessionJoinedSensor = {
                name: "Octopus Saving Session Joined",
                unique_id: `${uniqueIdPrefix}_saving_session_joined`,
                state_topic: stateTopic,
                value_template: "{{ value_json.saving_session_joined }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:account-check",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_saving_session_joined/config`, JSON.stringify(savingSessionJoinedSensor), { retain: true });

            // G3. Free Electricity Active Binary Sensor
            const freeElectricityActiveSensor = {
                name: "Octopus Free Electricity Active",
                unique_id: `${uniqueIdPrefix}_free_electricity_active`,
                state_topic: stateTopic,
                value_template: "{{ value_json.free_electricity_active }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:flash-circle",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_free_electricity_active/config`, JSON.stringify(freeElectricityActiveSensor), { retain: true });

            // G4. Free Electricity Available Binary Sensor
            const freeElectricityAvailableSensor = {
                name: "Octopus Free Electricity Available",
                unique_id: `${uniqueIdPrefix}_free_electricity_available`,
                state_topic: stateTopic,
                value_template: "{{ value_json.free_electricity_available }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:flash-circle-outline",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_free_electricity_available/config`, JSON.stringify(freeElectricityAvailableSensor), { retain: true });

            // G5. Octoplus Enrolled Binary Sensor
            // Published as binary_sensor (not sensor) because the value is a boolean —
            // HA's sensor domain rejects booleans without a device_class, leaving the
            // entity unregistered. No entity_category: 'config' on a read-only sensor
            // makes its state stick at "unavailable" on some HA installs (same fix as
            // the v1.3.0 tariff-sensor cleanup — see CHANGELOG).
            const octoplusEnrolledBinarySensor = {
                name: "Octopus Octoplus Enrolled",
                unique_id: `${uniqueIdPrefix}_octoplus_enrolled`,
                state_topic: stateTopic,
                value_template: "{{ value_json.octoplus_enrolled }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:star-circle",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_octoplus_enrolled/config`, JSON.stringify(octoplusEnrolledBinarySensor), { retain: true });

            // G6. Octoplus Loyalty Points (boolean) Binary Sensor
            // No entity_category — see G5.
            const octoplusLoyaltyBinarySensor = {
                name: "Octopus Octoplus Loyalty Points",
                unique_id: `${uniqueIdPrefix}_octoplus_loyalty_points_user`,
                state_topic: stateTopic,
                value_template: "{{ value_json.octoplus_loyalty_points_user }}",
                payload_on: "True",
                payload_off: "False",
                icon: "mdi:star",
                device: device
            };
            node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_octoplus_loyalty_points_user/config`, JSON.stringify(octoplusLoyaltyBinarySensor), { retain: true });

            // H. Announce Read-Only Sensors
            sensors.forEach(announceSensor);

            // H2. v1.5 — error binary_sensors (device_class: problem)
            errorSensors.forEach(announceErrorSensor);

            // H3. v1.7.0 SmartFlex vehicle and inverter entities depend on the devices Octopus
            // lists, so announceSmartflexEntities() publishes them once discovery has run.

            // I. Timezone Select Entity
            const TIMEZONE_OPTIONS = [
                "Europe/London", "Europe/Berlin", "Europe/Madrid",
                "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
                "Australia/Perth", "Australia/Adelaide", "Pacific/Auckland",
                "America/New_York", "America/Chicago", "America/Denver",
                "America/Los_Angeles", "Asia/Tokyo", "UTC"
            ];
            node.broker.client.publish(
                `${mqttPrefix}/select/${uniqueIdPrefix}_timezone/config`,
                JSON.stringify({
                    name: "Timezone",
                    unique_id: `${uniqueIdPrefix}_timezone`,
                    options: TIMEZONE_OPTIONS,
                    command_topic: cmdTopicTimezone,
                    state_topic: `${stateTopic}/timezone`,
                    icon: "mdi:earth",
                    entity_category: "config",
                    device: device
                }),
                { retain: true }
            );

            // J. Smart Charging Switch
            node.broker.client.publish(
                `${mqttPrefix}/switch/${uniqueIdPrefix}_smart_charging/config`,
                JSON.stringify({
                    name: "Smart Charging",
                    unique_id: `${uniqueIdPrefix}_smart_charging`,
                    command_topic: cmdTopicSmartCharging,
                    state_topic: `${stateTopic}/smart_charging`,
                    payload_on: "ON",
                    payload_off: "OFF",
                    icon: "mdi:lightning-bolt",
                    entity_category: "config",
                    device: device
                }),
                { retain: true }
            );

            // J2. Charge Cap Switch — limit smart charging to off-peak rates only (v1.6)
            node.broker.client.publish(
                `${mqttPrefix}/switch/${uniqueIdPrefix}_charge_cap/config`,
                JSON.stringify({
                    name: "Charge Cap",
                    unique_id: `${uniqueIdPrefix}_charge_cap`,
                    command_topic: cmdTopicChargeCap,
                    state_topic: `${stateTopic}/charge_cap`,
                    payload_on: "ON",
                    payload_off: "OFF",
                    icon: "mdi:cash-clock",
                    entity_category: "config",
                    device: device
                }),
                { retain: true }
            );

            // J3. The Boost Charge switch (v1.7) needs an EV, so announceSmartflexEntities()
            // publishes it once discovery has run.

            // K. v1.5 — Update entity (notify-only; Palette Manager is the install path)
            node.broker.client.publish(
                `${mqttPrefix}/update/${uniqueIdPrefix}_node_update/config`,
                JSON.stringify({
                    name: 'Octopus Intelligent Node',
                    unique_id: `${uniqueIdPrefix}_node_update`,
                    state_topic: `${stateTopic}/node_update`,
                    title: 'node-red-contrib-octopus-intelligent',
                    release_url: 'https://github.com/ASomerN/node-red-contrib-octopus-intelligent/releases',
                    device: device,
                }),
                { retain: true }
            );

            // Command topics are subscribed through node.broker.subscribe (see Handle MQTT Commands);
            // the broker subscribes the client when connected and again after every reconnect.
        }

        // 4b. v1.7.0 — SmartFlex entities, announced once product discovery has run. The Boost
        // Charge switch and the vehicle entities only when Octopus lists an ELECTRIC_VEHICLES
        // device (a car or a charge point: Kraken lists both that way); the experimental
        // inverter entities only when the editor option is ticked AND Octopus lists an inverter.
        // Otherwise their discovery topics are cleared, so Home Assistant removes them. A retained
        // empty config deletes the entity (names, areas, ids), so this only happens when Octopus
        // listed devices and none was of that kind: a transient empty list leaves them alone.
        function announceSmartflexEntities(discovered) {
            if (!enableMqtt || !node.broker || !node.broker.client) return;
            const clearSensor = (s) => node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_${s.id}/config`, "", { retain: true });
            const clearBinarySensor = (e) => node.broker.client.publish(`${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_${e.id}/config`, "", { retain: true });
            const devicesListed = discovered.deviceCount > 0
                || !!(discovered.deviceId || discovered.vehicleDeviceId || discovered.inverterDeviceId);
            const inverterOption = config.enableSmartflexInverter === true;
            if (!devicesListed) {
                node.log("SmartFlex: Octopus listed no devices, so the SmartFlex entities in Home Assistant are left as they are");
            }

            // Boost Charge switch: charge now, outside the plan (v1.7). Boost acts on the car or
            // charge point Octopus controls, so it is announced only when discovery found one
            // (review A10), by the same rule as the vehicle entities. Not a config setting, so no entity_category:
            // it sits with the main controls.
            const boostTopic = `${mqttPrefix}/switch/${uniqueIdPrefix}_boost/config`;
            if (discovered.deviceId) {
                node.broker.client.publish(boostTopic, JSON.stringify({
                    name: "Boost Charge",
                    unique_id: `${uniqueIdPrefix}_boost`,
                    command_topic: cmdTopicBoost,
                    state_topic: `${stateTopic}/boost`,
                    payload_on: "ON",
                    payload_off: "OFF",
                    // Its own icon: mdi:lightning-bolt-circle is already on two other entities.
                    icon: "mdi:rocket-launch",
                    device: device
                }), { retain: true });
            } else if (devicesListed) {
                node.broker.client.publish(boostTopic, "", { retain: true });
            }

            // Vehicle / charge point. The last-session problem flag is a boolean, so binary_sensor.
            const lastSessionProblemTopic = `${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_last_session_problem/config`;
            if (discovered.vehicleDeviceId) {
                vehicleSensors.forEach((s) => announceSensor(s, true));
                vehicleErrorSensors.forEach((e) => announceErrorSensor(e, true));
                const lastSessionProblemSensor = {
                    name: "Octopus Last Charge Session Problem",
                    unique_id: `${uniqueIdPrefix}_last_session_problem`,
                    state_topic: stateTopic,
                    value_template: `{{ ${valueOrNone('last_session_problem')} }}`,
                    availability: fieldAvailability('last_session_problem'),
                    payload_on: "True",
                    payload_off: "False",
                    // No icon: the problem class shows its own OK and Problem icons.
                    device_class: "problem",
                    device: device
                };
                node.broker.client.publish(lastSessionProblemTopic, JSON.stringify(lastSessionProblemSensor), { retain: true });
            } else if (devicesListed) {
                vehicleSensors.forEach(clearSensor);
                vehicleErrorSensors.forEach(clearBinarySensor);
                node.broker.client.publish(lastSessionProblemTopic, "", { retain: true });
            }

            // Inverter, EXPERIMENTAL.
            const inverterOnlineTopic = `${mqttPrefix}/binary_sensor/${uniqueIdPrefix}_inverter_online/config`;
            if (discovered.inverterDeviceId && inverterOption) {
                inverterSensors.forEach((s) => announceSensor(s, true));
                inverterErrorSensors.forEach((e) => announceErrorSensor(e, true));
                const inverterOnlineSensor = {
                    name: "Octopus Inverter Online",
                    unique_id: `${uniqueIdPrefix}_inverter_online`,
                    state_topic: stateTopic,
                    value_template: `{{ ${valueOrNone('inverter_online')} }}`,
                    availability: fieldAvailability('inverter_online'),
                    payload_on: "True",
                    payload_off: "False",
                    device_class: "connectivity",
                    entity_category: "diagnostic",
                    device: device
                };
                node.broker.client.publish(inverterOnlineTopic, JSON.stringify(inverterOnlineSensor), { retain: true });
            } else if (!inverterOption || devicesListed) {
                // Option off: removed on purpose. Option on: only when the list had devices.
                inverterSensors.forEach(clearSensor);
                inverterErrorSensors.forEach(clearBinarySensor);
                node.broker.client.publish(inverterOnlineTopic, "", { retain: true });
            }
        }

        // 5. Helper: Set Preferences (The Mutation)
        let retryTimeouts = []; // Track pending retry timeouts
        let expectedLimit = null;
        let expectedTime = null;
        let validationMode = false;
        let validationGen = 0; // each submit bumps it; an older validation chain then stops
        // Bumped when a preferences or Charge Cap write is sent and when a validation confirms.
        // A charging poll that started before a bump read the old values: it must not apply them.
        let prefsGen = 0;

        // Pending vs Confirmed state
        let pendingLimit = 80;
        let pendingTime = "08:00";
        let confirmedLimit = 80;
        let confirmedTime = "08:00";
        let chargeCapNaWarned = false; // warn once when the API says Charge Cap doesn't apply

        // Charging Now feature - timer-based state management
        let chargingNow = false;
        let preValidationTimer = null;  // Fires 30s before slot start
        let slotStartTimer = null;       // Fires at exact slot start
        let slotEndTimer = null;         // Fires at exact slot end
        let cachedSlots = [];            // Fresh slot data from pre-validation
        let stateCheckInterval = null;   // Reconciliation loop (every 10s)
        let lastSentChargingState = null;  // Track last sent state to avoid duplicates
        let chargingNowPublished = false;  // charging_now topic written since start (clears a stale retained ON)
        let boosting = null;             // null=unknown; true while status.currentState is BOOSTING
        let boostingConfirmedAt = 0;     // when Octopus last told us boosting (poll or boost answer)
        let boostHold = null;            // { value, since, until } after Octopus accepted a set_boost
        const BOOST_HOLD_MS = 2 * 60 * 1000;
        let boostError = null;           // last failed set_boost (also lastKnownState.boost_error)
        let boostErrorAt = 0;
        // A charging poll that starts this long after the failure and reads the device state
        // clears boost_error, so one refusal does not stay in every payload for days.
        const BOOST_ERROR_CLEAR_MS = 60 * 1000;

        // Manual refresh rate limiting (only for MQTT button, not Node-RED input)
        let lastManualRefresh = 0;       // Timestamp of last manual refresh
        const MANUAL_REFRESH_COOLDOWN = 30000;  // 30 seconds in milliseconds
        let cooldownExpiryTimer = null;  // Timer to clear cooldown state at expiry

        // Polling metrics
        let nextPollTime = null;         // ISO timestamp of next scheduled poll
        const metrics = createApiMetrics();

        // API Complexity Tracking
        // Octopus Energy API does not return actual complexity values in headers or extensions,
        // so we use estimated complexity based on query types:
        // - Regular poll (auth + data query): ~300
        // - Mutation (auth + setPreferences): ~250
        // - Pre-validation (auth + flexPlannedDispatches only): ~200

        // Smart charging state (startup, discovery, then every charging poll)
        let krakenflexDeviceId = null;
        // The EV discovery picked (the LIVE one, review L4). The charging poll, the startup
        // device fetch and the smart charging check read this device when it is listed.
        let preferredEvId = null;
        let smartChargingSuspended = null; // null=unknown, true=suspended(off), false=active(on)
        let smartChargingRetryTimeouts = [];
        let smartChargingVerifying = false;      // a toggle is waiting for Octopus to confirm it
        let publishedSmartCharging = null;       // last value written to the switch state topic
        let otherDeviceErrorLogged = false;      // charging poll: an error on another device was logged
        let statusWarned = false;                // warned that Octopus could not return the device status

        // Write the switch state topic (retained) when it differs from the last one written.
        function publishSmartChargingState(force) {
            if (smartChargingSuspended === null) return;
            const value = smartChargingSuspended ? "OFF" : "ON";
            if (!force && value === publishedSmartCharging) return;
            if (enableMqtt && node.broker && node.broker.client) {
                node.broker.client.publish(`${stateTopic}/smart_charging`, value, { retain: true });
                publishedSmartCharging = value;
            }
        }

        // Last known full state - prevents sensors going unknown when controls change
        let lastKnownState = buildDefaultPayload({ confirmedLimit, confirmedTime, pendingLimit, pendingTime, chargingNow, smartChargingSuspended });
        lastKnownState.installed_version = require('./package.json').version;

        // V2 category registry — populated after discovery
        let categories = [];

        // Lifecycle tracking — init setTimeouts must be clearable on close, and async
        // callbacks inside them must short-circuit if the node was closed mid-await,
        // otherwise a redeploy during the 2s warmup leaves an orphan V2 scheduler.
        // Each handle is removed when its timer fires, so the set stays small however long
        // discovery keeps retrying (it retries every 5 minutes for as long as it fails).
        const initTimeoutHandles = new Set();
        function initTimeout(fn, ms) {
            const handle = setTimeout(() => {
                initTimeoutHandles.delete(handle);
                return fn();
            }, ms);
            initTimeoutHandles.add(handle);
            return handle;
        }
        let nodeClosed = false;
        let lastWarnedVersion = null;
        let prevPublishedInstalled = null;
        let prevPublishedLatest = null;

        // Quick retry of the charging poll (1.6.2). Octopus fails flexPlannedDispatches
        // (KT-CT-4340) or the device preferences (KT-CT-4339) for a few minutes around :00/:30.
        // A retry only forces the charging category due, so it runs through the scheduler's
        // in-flight guard and never alongside a normal tick; nothing runs once the node closes.
        const dispatchRate = createRateWindow(); // max 3 flexPlannedDispatches queries in any 60 s
        let chargingOutage = null;  // { since, retryNo, retryAt, nextNormalAt } while the poll fails
        let retryPollRunning = false;
        // prefsGen when this tick's charging poll started (null: no charging poll this tick).
        let tickChargingPollGen = null;
        const PREFERENCE_FIELDS = ['confirmed_limit', 'confirmed_time', 'pending_limit', 'pending_time', 'charge_cap'];

        function noteDispatchQuery() {
            dispatchRate.record(Date.now());
        }

        // Called at the start of each tick: force the charging poll due when a retry is due.
        function startDueChargingRetry() {
            if (!chargingOutage || !chargingOutage.retryAt) return;
            const now = Date.now();
            if (now < chargingOutage.retryAt) return;
            const cat = categories.find((c) => c.id === 'intelligent');
            if (!cat || !cat.enabled || now >= chargingOutage.nextNormalAt) {
                chargingOutage.retryAt = null; // the normal poll takes over
                return;
            }
            const allowedAt = dispatchRate.nextAllowedAt(now);
            if (allowedAt > now) {
                // Too many dispatch queries this minute: wait, unless the normal poll comes first.
                chargingOutage.retryAt = allowedAt < chargingOutage.nextNormalAt ? allowedAt : null;
                return;
            }
            chargingOutage.retryAt = null;
            retryPollRunning = true;
            forceCategoryDue('intelligent');
        }

        function noteChargingPollFailure(err, isRetry, intervalMs) {
            const now = Date.now();
            if (!chargingOutage) chargingOutage = { since: now, retryNo: 0, retryAt: null, nextNormalAt: 0 };
            chargingOutage.nextNormalAt = nextSlotStart(now, intervalMs);
            chargingOutage.retryAt = null;
            // A Kraken error carries code and detail; a socket error (ENOTFOUND) has a code only.
            const text = err.code && err.detail !== undefined ? `${err.code} ${err.detail}` : err.message;
            let suffix = '';
            if (isRetryable(err)) {
                const retryNo = isRetry ? chargingOutage.retryNo + 1 : 1;
                const delay = retryDelay(retryNo);
                if (now + delay < chargingOutage.nextNormalAt) {
                    chargingOutage.retryNo = retryNo;
                    chargingOutage.retryAt = now + delay;
                    suffix = ` (retry ${retryNo} in ${Math.round(delay / 1000)}s)`;
                } else {
                    suffix = ` (next poll in ${Math.ceil((chargingOutage.nextNormalAt - now) / 1000)}s)`;
                }
            }
            node.warn(`Charging poll failed: ${short(text)}${suffix}`);
        }

        function noteChargingPollSuccess() {
            if (!chargingOutage) return;
            node.log(`Charging poll recovered after ${formatDuration(Date.now() - chargingOutage.since)}`);
            chargingOutage = null;
        }

        // The scheduler's charging poll: logs each failure and schedules the quick retry.
        async function scheduledIntelligentPoll(token, isStale) {
            const isRetry = retryPollRunning;
            retryPollRunning = false;
            tickChargingPollGen = prefsGen;
            try {
                return await intelligentPoll(token, isStale);
            } catch (e) {
                if (!nodeClosed && !(isStale && isStale())) {
                    const cat = categories.find((c) => c.id === 'intelligent');
                    noteChargingPollFailure(e, isRetry, cat ? cat.intervalMs : refreshRate);
                }
                if (typeof e.message === 'string') e.message = truncate(e.message);
                throw e;
            }
        }

        // The charging poll (first in the list) and completed dispatches, for an account with an EV.
        function intelligentCategoryEntry() {
            return {
                id: 'intelligent',
                enabled: true,
                intervalMs: (config.refreshInterval || 5) * 60 * 1000,
                lastPolled: 0,
                poll: scheduledIntelligentPoll,
            };
        }

        function completedDispatchesCategoryEntry() {
            return {
                id: 'completed_dispatches',
                enabled: true,
                intervalMs: 60 * 60 * 1000,
                lastPolled: 0,
                queryFn: () => completedDispatchesCategory.buildQuery(account),
                parseFn: d => completedDispatchesCategory.parseResponse(d),
                poll: simplePoll(
                    () => completedDispatchesCategory.buildQuery(account),
                    d => completedDispatchesCategory.parseResponse(d),
                    graphqlPost
                ),
            };
        }

        // v1.7.0 — SmartFlex vehicle / charge point details and charging sessions.
        function smartflexVehicleCategoryEntry(discovered) {
            return {
                id: 'smartflex_vehicle',
                enabled: true,
                intervalMs: 30 * 60 * 1000,
                lastPolled: 0,
                queryFn: () => smartflexVehicleCategory.buildQuery(account),
                parseFn: d => smartflexVehicleCategory.parseResponse(d, discovered.vehicleDeviceId),
                // Tolerates partial errors (e.g. on chargingSessions): keeps what came back
                // and the last values for the rest. Throws only when no vehicle data came back.
                poll: async (token) => {
                    const { query, variables } = smartflexVehicleCategory.buildQuery(account);
                    const response = await graphqlPost({ query, variables }, token);
                    const result = smartflexVehicleCategory.parseGraphqlResponse(response.data, discovered.vehicleDeviceId);
                    if (result.smartflex_vehicle_error && !nodeClosed) {
                        node.warn(`SmartFlex vehicle poll partly failed: ${result.smartflex_vehicle_error} - keeping the last values for the missing fields`);
                    }
                    // device_state comes from the charging poll: a charge point is listed as
                    // ELECTRIC_VEHICLES too, so every vehicle device has one.
                    return result;
                },
            };
        }

        // v1.7.0 — SmartFlex inverter telemetry. Experimental: not yet verified on a real
        // inverter, so it only runs when the editor option is ticked.
        function smartflexInverterCategoryEntry(discovered) {
            return {
                id: 'smartflex_inverter',
                enabled: true,
                intervalMs: 5 * 60 * 1000,
                lastPolled: 0,
                queryFn: () => smartflexInverterCategory.buildQuery(account),
                parseFn: d => smartflexInverterCategory.parseResponse(d, discovered.inverterDeviceId),
                poll: simplePoll(
                    () => smartflexInverterCategory.buildQuery(account),
                    d => smartflexInverterCategory.parseResponse(d, discovered.inverterDeviceId),
                    graphqlPost
                ),
            };
        }

        // The categories that need a device from discovery. Used by initCategories and by the
        // empty-device re-check, so both set up the same polls (review4 #1). `lead` goes first
        // in the list (the charging poll); `rest` goes after the account categories.
        function deviceCategoryEntries(discovered) {
            const lead = [];
            const rest = [];
            if (discovered.hasIntelligent) {
                lead.push(intelligentCategoryEntry());
                rest.push(completedDispatchesCategoryEntry());
            }
            if (discovered.vehicleDeviceId) rest.push(smartflexVehicleCategoryEntry(discovered));
            if (discovered.inverterDeviceId && config.enableSmartflexInverter === true) {
                rest.push(smartflexInverterCategoryEntry(discovered));
            }
            return { lead, rest };
        }

        async function initCategories(discovered) {
            categories = [];
            const deviceCategories = deviceCategoryEntries(discovered);

            categories.push(...deviceCategories.lead);

            const electricityEnabled = config.electricityEnabled !== false;
            const gasEnabled = config.gasEnabled !== false;

            if (discovered.hasElectricity && electricityEnabled) {
                const ratesMs = (config.electricityRatesInterval || 60) * 60 * 1000;
                const consumptionMs = (config.electricityConsumptionInterval || 60) * 60 * 1000;
                categories.push({
                    id: 'electricity_rates',
                    enabled: true,
                    intervalMs: ratesMs,
                    lastPolled: 0,
                    queryFn: () => electricityCategory.buildRatesQuery(account),
                    parseFn: d => electricityCategory.parseRatesResponse(d),
                    poll: simplePoll(
                        () => electricityCategory.buildRatesQuery(account),
                        d => electricityCategory.parseRatesResponse(d),
                        graphqlPost
                    ),
                });
                categories.push({
                    id: 'electricity_consumption',
                    enabled: true,
                    intervalMs: consumptionMs,
                    lastPolled: 0,
                    queryFn: () => electricityCategory.buildConsumptionQuery(account, config.timezoneOverride || 'UTC'),
                    parseFn: d => electricityCategory.parseConsumptionResponse(d, discovered.electricityMpan, discovered.electricityExportMpan),
                    poll: simplePoll(
                        () => electricityCategory.buildConsumptionQuery(account, config.timezoneOverride || 'UTC'),
                        d => electricityCategory.parseConsumptionResponse(d, discovered.electricityMpan, discovered.electricityExportMpan),
                        graphqlPost
                    ),
                });
            }

            if (discovered.hasGas && gasEnabled) {
                const ratesMs = (config.gasRatesInterval || 60) * 60 * 1000;
                const consumptionMs = (config.gasConsumptionInterval || 60) * 60 * 1000;
                categories.push({
                    id: 'gas_rates',
                    enabled: true,
                    intervalMs: ratesMs,
                    lastPolled: 0,
                    queryFn: () => gasCategory.buildRatesQuery(account),
                    parseFn: d => gasCategory.parseRatesResponse(d),
                    poll: simplePoll(
                        () => gasCategory.buildRatesQuery(account),
                        d => gasCategory.parseRatesResponse(d),
                        graphqlPost
                    ),
                });
                categories.push({
                    id: 'gas_consumption',
                    enabled: true,
                    intervalMs: consumptionMs,
                    lastPolled: 0,
                    queryFn: () => gasCategory.buildConsumptionQuery(account, config.timezoneOverride || 'UTC'),
                    parseFn: d => gasCategory.parseConsumptionResponse(d),
                    poll: simplePoll(
                        () => gasCategory.buildConsumptionQuery(account, config.timezoneOverride || 'UTC'),
                        d => gasCategory.parseConsumptionResponse(d),
                        graphqlPost
                    ),
                });
            }

            categories.push({
                id: 'wheel_of_fortune',
                enabled: config.enableWheelOfFortune || false,
                intervalMs: (config.wheelOfFortuneInterval || 60) * 60 * 1000,
                lastPolled: 0,
                queryFn: () => wheelOfFortuneCategory.buildQuery(account),
                parseFn: d => wheelOfFortuneCategory.parseResponse(d),
                poll: simplePoll(
                    () => wheelOfFortuneCategory.buildQuery(account),
                    d => wheelOfFortuneCategory.parseResponse(d),
                    graphqlPost
                ),
            });
            if (discovered.smartMeterDeviceId) {
                categories.push({
                    id: 'home_mini',
                    enabled: config.enableHomeMini || false,
                    intervalMs: (config.homeMiniInterval || 1) * 60 * 1000,
                    lastPolled: 0,
                    queryFn: () => homeMiniCategory.buildQuery(discovered.smartMeterDeviceId),
                    parseFn: d => homeMiniCategory.parseResponse(d),
                    poll: simplePoll(
                        () => homeMiniCategory.buildQuery(discovered.smartMeterDeviceId),
                        d => homeMiniCategory.parseResponse(d),
                        graphqlPost
                    ),
                });
            }
            categories.push({
                id: 'saving_sessions',
                enabled: true,
                intervalMs: (config.savingSessionsInterval || 60) * 60 * 1000,
                lastPolled: 0,
                queryFn: () => savingSessionsCategory.buildQuery(account),
                parseFn: d => savingSessionsCategory.parseResponse(d),
                poll: simplePoll(
                    () => savingSessionsCategory.buildQuery(account),
                    d => savingSessionsCategory.parseResponse(d),
                    graphqlPost
                ),
            });

            // Completed dispatches and the SmartFlex categories.
            categories.push(...deviceCategories.rest);

            if (discovered.hasElectricity && discovered.electricityMpan) {
                categories.push({
                    id: 'applicable_rates',
                    enabled: true,
                    intervalMs: (config.electricityRatesInterval || 60) * 60 * 1000,
                    lastPolled: 0,
                    queryFn: () => applicableRatesCategory.buildQuery(account, discovered.electricityMpan),
                    parseFn: d => applicableRatesCategory.parseResponse(d),
                    poll: simplePoll(
                        () => applicableRatesCategory.buildQuery(account, discovered.electricityMpan),
                        d => applicableRatesCategory.parseResponse(d),
                        graphqlPost
                    ),
                });
            }

            // Export applicable rates — second query with the export MPAN. Same parser,
            // different field prefix so the output keys don't collide with import.
            if (discovered.hasElectricity && discovered.electricityExportMpan) {
                categories.push({
                    id: 'applicable_rates_export',
                    errorField: 'electricity_export_rate_error',
                    enabled: true,
                    intervalMs: (config.electricityRatesInterval || 60) * 60 * 1000,
                    lastPolled: 0,
                    queryFn: () => applicableRatesCategory.buildQuery(account, discovered.electricityExportMpan),
                    parseFn: d => applicableRatesCategory.parseResponse(d, { fieldPrefix: 'electricity_export_rate' }),
                    poll: simplePoll(
                        () => applicableRatesCategory.buildQuery(account, discovered.electricityExportMpan),
                        d => applicableRatesCategory.parseResponse(d, { fieldPrefix: 'electricity_export_rate' }),
                        graphqlPost
                    ),
                });
            }

            if (discovered.hasElectricity && discovered.electricityMpan) {
                categories.push({
                    id: 'free_electricity',
                    enabled: true,
                    intervalMs: 30 * 60 * 1000,  // 30 minutes
                    lastPolled: 0,
                    queryFn: () => freeElectricityCategory.buildQuery(account, discovered.electricityMpan),
                    parseFn: d => freeElectricityCategory.parseResponse(d),
                    poll: simplePoll(
                        () => freeElectricityCategory.buildQuery(account, discovered.electricityMpan),
                        d => freeElectricityCategory.parseResponse(d),
                        graphqlPost
                    ),
                });
            }

            categories.push({
                id: 'account',
                enabled: true,
                intervalMs: 60 * 60 * 1000,
                lastPolled: 0,
                queryFn: () => accountCategory.buildQuery(account),
                parseFn: d => accountCategory.parseResponse(d),
                poll: simplePoll(
                    () => accountCategory.buildQuery(account),
                    d => accountCategory.parseResponse(d),
                    graphqlPost
                ),
            });

            categories.push({
                id: 'octoplus',
                enabled: true,
                intervalMs: 60 * 60 * 1000,
                lastPolled: 0,
                queryFn: () => octoplusCategory.buildQuery(account),
                parseFn: d => octoplusCategory.parseResponse(d),
                poll: simplePoll(
                    () => octoplusCategory.buildQuery(account),
                    d => octoplusCategory.parseResponse(d),
                    graphqlPost
                ),
            });

            categories.push({
                id: 'update_check',
                enabled: true,
                intervalMs: 24 * 60 * 60 * 1000, // 24h — once daily npm registry check
                lastPolled: 0,                   // fires on first scheduler tick
                poll: intelligentUpdateCheck,    // token ignored
                needsToken: false,               // still runs when the Octopus token request fails
            });
        }

        async function pollDueCategories(isStale) {
            if (nodeClosed) return;
            startDueChargingRetry();
            startDeferredChargingPoll();
            tickChargingPollGen = null;
            const result = await runTick({
                categories,
                state: lastKnownState,
                getToken: tickToken,
                // Stop at the next category once the node is closed, not only when superseded.
                isStale: () => nodeClosed || !!(isStale && isStale()),
            });
            // A retry tick whose poll never ran (e.g. auth failed) must not mark the next poll a retry.
            retryPollRunning = false;
            if (nodeClosed || (isStale && isStale())) return;
            if (!result.emitted) return;
            logCategoryFailures(result.changes);
            // Apply only this tick's changes onto the current state: a validation poll, a Charge
            // Cap change or an active-fields refresh may have written it while the tick waited
            // on Octopus. A slot timer may have changed charging_now, and a set_boost answer
            // boosting or boost_error, meanwhile (review F4).
            let changes = result.changes;
            // A change was sent or confirmed after this tick's charging poll started (for example
            // a validation poll while a later category ran): the poll's target, ready-by time and
            // Charge Cap are older than what the state holds now, so keep the state's values.
            if (tickChargingPollGen !== null && prefsGen !== tickChargingPollGen) {
                changes = Object.assign({}, changes);
                PREFERENCE_FIELDS.forEach((f) => { delete changes[f]; });
            }
            tickChargingPollGen = null;
            // charging_now, boosting and boost_error, and the pending target and ready-by time,
            // from the node's own values: a slot timer, a set_boost answer, or a slider or
            // ready-by change in Home Assistant that was not applied yet (it does not bump
            // prefsGen), may have changed them while the tick waited (review F4). The charging
            // poll sets these values itself, so they never disagree with a fresh poll.
            lastKnownState = mergePayload(mergePayload(lastKnownState, changes), {
                charging_now: chargingNow,
                boosting,
                boost_error: boostError,
                pending_limit: pendingLimit,
                pending_time: pendingTime,
            });
            if (enableMqtt && node.broker && node.broker.client) {
                node.broker.client.publish(stateTopic, stateJson(lastKnownState), { retain: true });
                // v1.5 — publish update entity state only when version values change
                if (prevPublishedInstalled !== lastKnownState.installed_version
                    || prevPublishedLatest !== lastKnownState.latest_version) {
                    const updateState = {
                        installed_version: lastKnownState.installed_version,
                        latest_version: lastKnownState.latest_version || lastKnownState.installed_version,
                    };
                    node.broker.client.publish(`${stateTopic}/node_update`, JSON.stringify(updateState), { retain: true });
                    prevPublishedInstalled = lastKnownState.installed_version;
                    prevPublishedLatest = lastKnownState.latest_version;
                }
            }
            node.send({ payload: lastKnownState });
            if (lastKnownState.update_available === true
                && lastKnownState.latest_version
                && lastKnownState.latest_version !== lastWarnedVersion) {
                node.warn(`Update available: v${lastKnownState.latest_version} (running v${lastKnownState.installed_version}). Install via Node-RED → Manage Palette → Upgrade.`);
                lastWarnedVersion = lastKnownState.latest_version;
            }
            const octopusCategories = categories.filter((c) => c.enabled && c.needsToken !== false);
            const hasChargingPoll = categories.some((c) => c.id === 'intelligent');
            if (!hasChargingPoll) {
                // No car or charger: there is no "Confirmed" status to show, so show the first
                // Octopus poll error (red when every Octopus poll failed, yellow when some did).
                const failed = octopusCategories.filter((c) => lastKnownState[`${c.id}_error`]);
                if (failed.length > 0) {
                    const first = failed[0];
                    node.status({
                        fill: failed.length === octopusCategories.length ? "red" : "yellow",
                        shape: "ring",
                        text: truncate(`${first.id}: ${lastKnownState[`${first.id}_error`]}`, 80),
                    });
                } else {
                    node.status({ fill: "green", shape: "dot", text: `Confirmed: ${confirmedLimit}% @ ${confirmedTime}` });
                }
            } else if (!validationMode) {
                if (writeNotApplied) {
                    // A write that got no answer was checked by this tick's charging poll: not applied.
                    node.status({ fill: "red", shape: "ring", text: writeNotApplied });
                    writeNotApplied = null;
                } else if (lastKnownState.intelligent_error) {
                    // "Error: KT-CT-4340: Unable to fetch planned dispatches", capped for the editor.
                    // The "Error: " prefix is what 1.6.1 showed: flows can match it in a Status node.
                    node.status({ fill: "red", shape: "ring", text: truncate('Error: ' + lastKnownState.intelligent_error, 80) });
                } else {
                    node.status({ fill: "green", shape: "dot", text: `Confirmed: ${confirmedLimit}% @ ${confirmedTime}` });
                }
            }
        }

        // A failed category poll (or update check) used to show only in its <id>_error field.
        // Warn once when a run of failures starts and log one line when it works again. The
        // charging poll logs its own failures, and a failed login is logged by tickToken.
        function logCategoryFailures(changes) {
            for (const cat of categories) {
                if (cat.id === 'intelligent') continue;
                const field = `${cat.id}_error`;
                if (!(field in changes)) continue; // not polled this tick
                const err = changes[field];
                if (typeof err === 'string' && err) {
                    if (/^Auth failed: /.test(err)) continue;
                    if (!cat.failureLogged) {
                        cat.failureLogged = true;
                        node.warn(`${cat.id} poll failed: ${truncate(err)}`);
                    }
                } else if (err === null && cat.failureLogged) {
                    cat.failureLogged = false;
                    node.log(`${cat.id} poll working again`);
                }
            }
        }

        // The tick's token request. A failure used to write nothing to the log (only the
        // *_error fields): warn once when a run of failures starts and log when it ends.
        let tickAuthFailing = false;
        async function tickToken() {
            let token;
            try {
                token = await obtainTickToken();
            } catch (e) {
                if (!tickAuthFailing && !nodeClosed) {
                    tickAuthFailing = true;
                    node.warn(`Octopus login failed: ${truncate(e.message)}. Polls try again with back-off.`);
                }
                throw e;
            }
            if (tickAuthFailing && !nodeClosed) {
                tickAuthFailing = false;
                node.log('Octopus login working again');
            }
            return token;
        }

        async function obtainTickToken() {
            const response = await graphqlPost({
                query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                variables: { input: { APIKey: apiKey } },
            });
            if (!response.data.data || !response.data.data.obtainKrakenToken) {
                const why = response.data.errors ? graphqlError(response.data.errors).message : JSON.stringify(response.data);
                throw new Error(truncate('Auth response missing token: ' + why));
            }
            return response.data.data.obtainKrakenToken.token;
        }

        // forceSeq lets runTick keep the category due when this lands during its poll.
        function forceCategoryDue(id) {
            const cat = categories.find((c) => c.id === id);
            if (!cat) return;
            cat.forceSeq = (cat.forceSeq || 0) + 1;
            cat.lastPolled = 0;
        }

        // A write mutation that got no answer (time-out, connection closed after the request
        // was sent, HTTP 5xx) may still have been applied by Octopus. Mark it so the caller
        // checks with the next charging poll rather than reporting a failure. A DNS or connect
        // error, an HTTP 4xx or an unreadable reply is a plain failure, and so is a GraphQL
        // refusal (it comes back as `errors`).
        function unconfirmedWrite(e) {
            if (!isUnconfirmedWriteError(e)) throw e;
            const err = new Error(e && e.message ? e.message : String(e));
            err.unconfirmed = true;
            throw err;
        }

        // Writes that got no answer, checked against what the next charging poll reads.
        let unconfirmedPrefs = null;  // { limit, time }
        let unconfirmedCap = null;    // { enabled }
        let writeNotApplied = null;   // red status text for the end of the tick: a check failed

        // Called by a charging poll that read the preferences (prefsRead) and/or Charge Cap
        // (capRead). A match is a normal confirmed change; a mismatch means Octopus did not
        // apply the write.
        function checkUnconfirmedWrites(chargeCap, prefsRead, capRead) {
            if (unconfirmedPrefs && prefsRead) {
                const want = unconfirmedPrefs;
                unconfirmedPrefs = null;
                if (confirmedLimit === want.limit && confirmedTime === want.time) {
                    node.log(`Preferences update confirmed: ${confirmedLimit}% @ ${confirmedTime}`);
                } else {
                    node.warn(`Preferences update not applied: sent ${want.limit}% @ ${want.time}, Octopus has ${confirmedLimit}% @ ${confirmedTime}`);
                    writeNotApplied = "Update Failed";
                }
            }
            if (unconfirmedCap && capRead) {
                const want = unconfirmedCap;
                unconfirmedCap = null;
                if (chargeCap === want.enabled) {
                    node.log(`Charge Cap change confirmed: ${want.enabled ? "on" : "off"}`);
                } else {
                    node.warn(`Charge Cap change not applied: sent ${want.enabled ? "on" : "off"}, Octopus has ${chargeCap === null ? "unknown" : (chargeCap ? "on" : "off")}`);
                    writeNotApplied = "Charge Cap update failed";
                }
            }
        }

        // limit/time are validated by the caller (or come from the API as confirmed values).
        async function setPreferences(limit, time) {

            // Cancel any pending retry attempts from previous changes. A check already waiting
            // on Octopus sees the new generation and stops, so two chains never run at once.
            retryTimeouts.forEach(timeout => clearTimeout(timeout));
            retryTimeouts = [];
            const gen = ++validationGen;
            unconfirmedPrefs = null; // a newer change replaces one still to be checked
            writeNotApplied = null;

            try {
                node.status({ fill: "blue", shape: "dot", text: "Updating Settings..." });

                // A. Get Token
                const authResponse = await graphqlPost({
                    query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                    variables: { input: { APIKey: apiKey } }
                });

                if (authResponse.data.errors) {
                    throw new Error(`Auth failed: ${JSON.stringify(authResponse.data.errors)}`);
                }
                if (!authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                    throw new Error(`Auth response missing token data`);
                }

                const token = authResponse.data.data.obtainKrakenToken.token;

                // B. Send Mutation
                if (!krakenflexDeviceId) {
                    throw new Error('Device ID not available — cannot set preferences');
                }

                const mutation = `
                mutation setPreferences($input: SmartFlexDevicePreferencesInput!) {
                    setDevicePreferences(input: $input) { __typename }
                }`;

                const DAYS = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];
                function buildDevicePreferencesInput(deviceId, socLimit, readyTime) {
                    return {
                        deviceId,
                        mode: 'CHARGE',
                        unit: 'PERCENTAGE',
                        schedules: DAYS.map(dayOfWeek => ({
                            dayOfWeek,
                            time: readyTime + ':00',
                            min: 0,
                            max: socLimit
                        }))
                    };
                }

                const variables = {
                    input: buildDevicePreferencesInput(krakenflexDeviceId, limit, time)
                };

                prefsGen++;
                const mutationResponse = await graphqlPost({
                    query: mutation,
                    variables: variables
                }, token).catch(unconfirmedWrite);
                if (nodeClosed) return;
                if (gen !== validationGen) return; // a newer submit owns validation now

                if (mutationResponse.data.errors) {
                    throw new Error(`Mutation failed: ${JSON.stringify(mutationResponse.data.errors)}`);
                }

                // Record mutation API usage (auth + mutation = ~250 complexity)
                const ESTIMATED_MUTATION_COMPLEXITY = 250;
                metrics.recordPoll(ESTIMATED_MUTATION_COMPLEXITY);

                // C. Start exponential backoff validation
                expectedLimit = limit;
                expectedTime = time;
                validationMode = true;
                node.status({ fill: "blue", shape: "ring", text: "Verifying changes..." });

                // Schedule retries with exponential backoff: 15s, 30s, 60s, 120s
                const retryIntervals = [15000, 30000, 60000, 120000];
                scheduleRetries(retryIntervals, 0, gen);

            } catch (err) {
                if (nodeClosed) return;
                if (err.unconfirmed) {
                    node.warn(`Preferences update not confirmed (${short(err.message)}) - checking with Octopus`);
                } else {
                    node.error("Failed to set preferences: " + short(err.message));
                    if (err.response) {
                        node.error(`Response: ${short(JSON.stringify(err.response.data))}`);
                    }
                }
                if (gen !== validationGen) return; // a newer submit owns the status and validation
                expectedLimit = null;
                expectedTime = null;
                validationMode = false;
                if (err.unconfirmed) {
                    unconfirmedPrefs = { limit, time }; // the next charging poll checks it
                    node.status({ fill: "yellow", shape: "ring", text: "Update unconfirmed - checking" });
                    forceCategoryDue('intelligent'); // the next tick reads what Octopus has
                    return;
                }
                node.status({ fill: "red", shape: "ring", text: "Update Failed" });
            }
        }

        function scheduleRetries(intervals, index, gen) {
            if (nodeClosed || gen !== validationGen) return;
            if (index >= intervals.length) {
                // All retries exhausted, let normal interval take over
                node.status({ fill: "yellow", shape: "dot", text: "Waiting for normal sync..." });
                expectedLimit = null;
                expectedTime = null;
                validationMode = false;
                return;
            }

            const timeout = setTimeout(async () => {
                await fetchDataWithValidation(intervals, index, gen);
            }, intervals[index]);

            retryTimeouts.push(timeout);
        }

        async function fetchDataWithValidation(intervals, currentIndex, gen) {
            try {
                const token = await obtainTickToken();
                const partial = await intelligentPoll(token);
                if (nodeClosed || gen !== validationGen) return;
                lastKnownState = Object.assign({}, lastKnownState, partial, { intelligent_error: null });
                if (enableMqtt && node.broker && node.broker.client) {
                    node.broker.client.publish(stateTopic, stateJson(lastKnownState), { retain: true });
                }
                node.send({ payload: lastKnownState });

                const validated = (confirmedLimit === expectedLimit && confirmedTime === expectedTime);
                if (validated) {
                    prefsGen++; // a charging poll still in flight read the old values
                    validationMode = false;
                    retryTimeouts.forEach((t) => clearTimeout(t));
                    retryTimeouts = [];
                    node.status({ fill: "green", shape: "dot", text: `Confirmed: ${confirmedLimit}% @ ${confirmedTime}` });
                    return;
                }
                const totalAttempts = intervals.length;
                const attempt = currentIndex + 1;
                if (currentIndex < intervals.length - 1) {
                    node.status({ fill: "blue", shape: "ring", text: `Retry ${attempt}/${totalAttempts}...` });
                    scheduleRetries(intervals, currentIndex + 1, gen);
                } else {
                    validationMode = false;
                    node.status({ fill: "red", shape: "ring", text: "Validation timed out" });
                }
            } catch (error) {
                if (nodeClosed || gen !== validationGen) return;
                node.warn(`Retry ${currentIndex + 1} failed: ${short(error.message)}`);
                if (currentIndex < intervals.length - 1) {
                    scheduleRetries(intervals, currentIndex + 1, gen);
                } else {
                    validationMode = false;
                    node.status({ fill: "red", shape: "ring", text: "Validation failed" });
                }
            }
        }

        // Helper: Toggle smart charging on/off
        async function setSmartCharging(enable) {
            if (!krakenflexDeviceId) {
                node.warn("Device ID not available — cannot toggle smart charging");
                return;
            }

            // Cancel any pending verification retries
            smartChargingRetryTimeouts.forEach(t => clearTimeout(t));
            smartChargingRetryTimeouts = [];

            const previousSuspended = smartChargingSuspended;

            try {
                node.status({ fill: "blue", shape: "dot", text: enable ? "Enabling smart charging..." : "Suspending smart charging..." });

                const authResponse = await graphqlPost({
                    query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                    variables: { input: { APIKey: apiKey } }
                });
                if (authResponse.data.errors || !authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                    throw new Error(`Auth failed: ${JSON.stringify(authResponse.data.errors)}`);
                }
                const token = authResponse.data.data.obtainKrakenToken.token;

                const action = enable ? "UNSUSPEND" : "SUSPEND";
                const mutationResponse = await graphqlPost({
                    query: `mutation UpdateSmartControl($deviceId: ID!, $action: SmartControlAction!) { updateDeviceSmartControl(input: { deviceId: $deviceId, action: $action }) { id } }`,
                    variables: { deviceId: krakenflexDeviceId, action: action }
                }, token).catch(unconfirmedWrite);
                if (nodeClosed) return;

                if (mutationResponse.data.errors) {
                    throw new Error(`Smart charging mutation failed: ${JSON.stringify(mutationResponse.data.errors)}`);
                }

                // Record mutation API usage (auth + mutation = ~250 complexity)
                const ESTIMATED_MUTATION_COMPLEXITY = 250;
                metrics.recordPoll(ESTIMATED_MUTATION_COMPLEXITY);

                // Optimistically update cached state
                const expectedSuspended = !enable;
                smartChargingSuspended = expectedSuspended;

                // Publish new state to HA switch topic immediately
                publishSmartChargingState(true);

                // Schedule verification: 15s / 30s / 60s / 120s
                smartChargingVerifying = true;
                scheduleSmartChargingVerification(expectedSuspended, [15000, 30000, 60000, 120000], 0);

            } catch (e) {
                if (nodeClosed) return;
                if (e.unconfirmed) {
                    // No answer: Octopus may have made the change. The switch keeps the last known
                    // state while the usual 15/30/60/120 s checks read what Octopus has.
                    node.warn(`Smart charging change not confirmed (${short(e.message)}) - checking with Octopus`);
                    smartChargingSuspended = previousSuspended;
                    publishSmartChargingState(true);
                    node.status({ fill: "yellow", shape: "ring", text: "Smart charging unconfirmed - checking" });
                    smartChargingVerifying = true;
                    scheduleSmartChargingVerification(!enable, [15000, 30000, 60000, 120000], 0);
                    return;
                }
                node.error(`Failed to toggle smart charging: ${short(e.message)}`);
                // Revert optimistic update to pre-mutation state
                smartChargingSuspended = previousSuspended;
                smartChargingVerifying = false;
                node.status({ fill: "red", shape: "ring", text: "Smart charging update failed" });
                // Republish previous state so HA switch UI re-syncs
                publishSmartChargingState(true);
            }
        }

        // Helper: Toggle Charge Cap (off-peak-only smart charging). State is confirmed by the
        // next intelligent poll, so no bespoke verification loop.
        async function setChargeCap(enabled) {
            if (!krakenflexDeviceId) {
                node.warn("Device ID not available — cannot change Charge Cap");
                return;
            }
            const previous = lastKnownState ? lastKnownState.charge_cap : null;
            unconfirmedCap = null; // a newer change replaces one still to be checked
            writeNotApplied = null;
            try {
                node.status({ fill: "blue", shape: "dot", text: enabled ? "Enabling Charge Cap..." : "Disabling Charge Cap..." });
                const token = await obtainTickToken();
                prefsGen++;
                const res = await graphqlPost({
                    query: `mutation SetChargeCap($input: UpdateIsChargingDurationCappedInput!) { updateIsChargingDurationCapped(input: $input) { __typename } }`,
                    variables: { input: { deviceId: krakenflexDeviceId, enabled } }
                }, token).catch(unconfirmedWrite);
                if (nodeClosed) return;
                if (res.data.errors) {
                    throw new Error(`Charge Cap mutation failed: ${JSON.stringify(res.data.errors)}`);
                }
                metrics.recordPoll(250); // auth + mutation, same estimate as other mutations
                lastKnownState = mergePayload(lastKnownState, { charge_cap: enabled });
                if (enableMqtt && node.broker && node.broker.client) {
                    node.broker.client.publish(`${stateTopic}/charge_cap`, enabled ? "ON" : "OFF", { retain: true });
                }
                node.status({ fill: "green", shape: "dot", text: `Charge Cap ${enabled ? "on" : "off"}` });
                forceCategoryDue('intelligent'); // next tick confirms from the API
            } catch (e) {
                if (nodeClosed) return;
                if (e.unconfirmed) {
                    unconfirmedCap = { enabled }; // the next charging poll checks it
                    node.warn(`Charge Cap change not confirmed (${short(e.message)}) - checking with Octopus`);
                    node.status({ fill: "yellow", shape: "ring", text: "Charge Cap unconfirmed - checking" });
                    forceCategoryDue('intelligent'); // the next tick reads what Octopus has
                } else {
                    node.error(`Failed to change Charge Cap: ${short(e.message)}`);
                    node.status({ fill: "red", shape: "ring", text: "Charge Cap update failed" });
                }
                // Republish previous state so the HA switch re-syncs
                if (enableMqtt && node.broker && node.broker.client && typeof previous === 'boolean') {
                    node.broker.client.publish(`${stateTopic}/charge_cap`, previous ? "ON" : "OFF", { retain: true });
                }
            }
        }

        // Boosting changed (mutation read-back): publish it and let charging_now follow,
        // since a boost counts as charging (charging_now = slot active OR boosting).
        function applyBoosting(value) {
            if (typeof value !== 'boolean') return;
            boosting = value;
            boostingConfirmedAt = Date.now();
            lastKnownState = mergePayload(lastKnownState, { boosting: value });
            publishBoostSwitch(value);
            const shouldBeCharging = chargingNowFor(cachedSlots, boosting);
            if (shouldBeCharging !== chargingNow) publishChargingState(shouldBeCharging);
        }

        // Boost Charge switch state topic (retained): ON, OFF, or None, which Home Assistant
        // shows as unknown.
        function publishBoostSwitch(value) {
            if (!(enableMqtt && node.broker && node.broker.client)) return;
            const text = value === true ? "ON" : value === false ? "OFF" : "None";
            node.broker.client.publish(`${stateTopic}/boost`, text, { retain: true });
        }

        // A set_boost that failed: warn, set boost_error and send it at once (a refusal forces
        // no poll), and put the HA switch back to the last known state so it re-syncs.
        function reportBoostFailure(enabled, rawError) {
            const label = enabled ? "Boost request" : "Boost cancel";
            // Masked and cut here, so boost_error keeps its contract whatever the caller passes.
            const error = truncate(rawError == null ? 'Unknown error' : rawError);
            node.warn(`${label} failed: ${error}`);
            boostError = error;
            boostErrorAt = Date.now();
            lastKnownState = mergePayload(lastKnownState, { boost_error: error });
            node.status({ fill: "red", shape: "ring", text: `${label} failed` });
            if (typeof boosting === 'boolean') publishBoostSwitch(boosting);
            if (enableMqtt && node.broker && node.broker.client) {
                node.broker.client.publish(stateTopic, stateJson(lastKnownState), { retain: true });
            }
            // Tagged like the other extra messages (review L6), so a flow can tell it from a poll.
            node.send({
                payload: lastKnownState,
                debug: { timestamp: new Date().toISOString(), trigger: 'boost_failed', request: enabled ? 'BOOST' : 'CANCEL', error },
            });
        }

        // Boost requests are serialised (sweep #2/#3, review F2): one updateBoostCharge in flight,
        // the latest requested value wins, a repeat of the value in flight (or just sent and
        // accepted) is dropped, and mutations are at least BOOST_SPACING_MS apart. A flood of ON/OFF messages
        // therefore makes only a few calls, and ON then OFF can never reach Octopus out of order.
        const BOOST_SPACING_MS = 5000;
        // A request still unanswered after this long is given up (review A1): a connection that
        // drops mid-answer can leave it pending for ever, and the queue would wait for ever too.
        // 2 x the 30 s request timeout (auth + mutation) plus a margin.
        const BOOST_WATCHDOG_MS = 75 * 1000;
        const boostQueue = { inFlight: null, pending: null, lastValue: null, lastOk: false, lastAt: 0, timer: null, watchdog: null };
        // Review A5: a flow or automation that asks again after every refusal would otherwise
        // send the same refused request every 5 s, all day, on the API key the polls use.
        // 3 refusals of one value in 10 minutes pause that value for 10 minutes (one warning).
        // An accepted request ends the pause.
        const BOOST_REFUSAL_LIMIT = 3;
        const BOOST_REFUSAL_WINDOW_MS = 10 * 60 * 1000;
        const BOOST_PAUSE_MS = 10 * 60 * 1000;
        let boostRefusals = { value: null, times: [] };
        let boostPause = null; // { value, until }

        function noteBoostRefusal(enabled) {
            const now = Date.now();
            if (boostRefusals.value !== enabled) boostRefusals = { value: enabled, times: [] };
            boostRefusals.times = boostRefusals.times.filter((t) => now - t < BOOST_REFUSAL_WINDOW_MS);
            boostRefusals.times.push(now);
            if (boostRefusals.times.length < BOOST_REFUSAL_LIMIT) return;
            boostRefusals = { value: null, times: [] };
            boostPause = { value: enabled, until: now + BOOST_PAUSE_MS };
            const what = enabled ? "boost requests" : "boost cancels";
            node.warn(`Octopus refused ${BOOST_REFUSAL_LIMIT} ${what} in ${BOOST_REFUSAL_WINDOW_MS / 60000} minutes: ignoring further ${what} for ${BOOST_PAUSE_MS / 60000} minutes`);
        }

        function clearBoostRefusals() {
            boostRefusals = { value: null, times: [] };
            boostPause = null;
        }

        function requestBoost(enabled) {
            if (nodeClosed) return;
            const q = boostQueue;
            if (boostPause && boostPause.value === enabled) {
                if (Date.now() < boostPause.until) {
                    // Paused after repeated refusals: ignored (the warning was logged once).
                    if (typeof boosting === 'boolean' && boosting !== enabled) publishBoostSwitch(boosting);
                    return;
                }
                boostPause = null;
            }
            if (q.inFlight !== null) {
                // Sent when the one in flight ends; asking for the in-flight value cancels it.
                q.pending = enabled === q.inFlight ? null : enabled;
                return;
            }
            // Already done and Octopus agrees (e.g. a flow sending set_boost true in a loop).
            // After a refusal, or once the boost has ended, the same value is sent again.
            const alreadyDone = enabled === q.lastValue && q.lastOk && boosting === enabled;
            const waitMs = q.lastAt + BOOST_SPACING_MS - Date.now();
            if (alreadyDone || waitMs > 0) {
                // The latest request wins: a repeat of the value just sent and accepted cancels a
                // waiting one and is dropped. After a failure the same value waits for the gap
                // and is sent again, instead of being dropped (review A9).
                const repeat = alreadyDone || (enabled === q.lastValue && q.lastOk);
                q.pending = repeat ? null : enabled;
                if (q.pending === null) {
                    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
                    // The HA switch may show the tapped value: put it back to the known state.
                    if (typeof boosting === 'boolean' && boosting !== enabled) publishBoostSwitch(boosting);
                } else if (!q.timer) {
                    q.timer = setTimeout(sendPendingBoost, waitMs);
                }
                return;
            }
            sendBoost(enabled);
        }

        function sendPendingBoost() {
            boostQueue.timer = null;
            const value = boostQueue.pending;
            boostQueue.pending = null;
            if (value !== null) requestBoost(value);
        }

        function sendBoost(enabled) {
            const q = boostQueue;
            // This request replaces any one waiting for the gap (review A8): a late timer
            // must not send an older value after this newer one.
            if (q.timer) { clearTimeout(q.timer); q.timer = null; }
            q.pending = null;
            q.inFlight = enabled;
            q.lastValue = enabled;
            q.lastOk = false;
            q.lastAt = Date.now();
            // abandoned: the watchdog gave up on this request, so a late answer changes nothing.
            const call = { settled: false, abandoned: false };
            const done = (ok) => {
                if (call.settled) return;
                call.settled = true;
                if (q.watchdog) { clearTimeout(q.watchdog); q.watchdog = null; }
                q.lastOk = ok === true;
                q.inFlight = null;
                if (nodeClosed || q.pending === null) return;
                const value = q.pending;
                q.pending = null;
                requestBoost(value); // waits out the spacing if this one was quick
            };
            q.watchdog = setTimeout(() => {
                q.watchdog = null;
                if (call.settled || nodeClosed) return;
                call.abandoned = true;
                // The request may still have reached Octopus: report it, then poll to find out.
                reportBoostFailure(enabled, `No answer from Octopus after ${Math.round(BOOST_WATCHDOG_MS / 1000)}s`);
                requestChargingPoll();
                done(false);
            }, BOOST_WATCHDOG_MS);
            // A newer, different request is waiting: this answer must not move the switch.
            setBoost(enabled, call, () => q.pending !== null).then(done, () => done(false));
        }

        // A forced charging poll also queries flexPlannedDispatches, so it goes through the same
        // rate window as the quick retries (review F2). Not allowed now: it runs when allowed.
        let deferredChargingPollAt = null;

        function requestChargingPoll() {
            const now = Date.now();
            const allowedAt = dispatchRate.nextAllowedAt(now);
            if (allowedAt <= now) {
                deferredChargingPollAt = null;
                forceCategoryDue('intelligent');
                return;
            }
            if (deferredChargingPollAt === null) {
                node.log(`Charging poll after boost waits ${Math.ceil((allowedAt - now) / 1000)}s: 3 planned-dispatch queries already went out this minute`);
            }
            deferredChargingPollAt = allowedAt;
        }

        // Called at the start of each tick, next to startDueChargingRetry.
        function startDeferredChargingPoll() {
            if (deferredChargingPollAt === null || Date.now() < deferredChargingPollAt) return;
            deferredChargingPollAt = null;
            requestChargingPoll();
        }

        // Helper: Boost charge (charge now, outside the plan) or cancel a boost. Different from
        // setSmartCharging, which suspends/resumes Octopus control. Octopus may refuse (e.g. car
        // unplugged or full); its error is passed through, not second-guessed here.
        // Called through requestBoost only, so one runs at a time. Resolves true when Octopus
        // accepted the request and its answer was used.
        async function setBoost(enabled, call, isSuperseded) {
            const label = enabled ? "Boost request" : "Boost cancel";
            // Closed, or given up by the watchdog: a late answer changes nothing.
            const gone = () => nodeClosed || call.abandoned;
            const superseded = () => {
                if (!isSuperseded || !isSuperseded()) return false;
                node.log(`${label} answered, but a newer request follows: ignoring this answer`);
                return true;
            };
            const fail = (error) => reportBoostFailure(enabled, error);
            if (!krakenflexDeviceId) {
                fail("Device ID not available");
                return false;
            }
            try {
                node.status({ fill: "blue", shape: "dot", text: enabled ? "Requesting boost..." : "Cancelling boost..." });
                const token = await obtainTickToken();
                if (gone()) return false;
                const res = await graphqlPost(buildBoostRequest(krakenflexDeviceId, enabled), token);
                if (gone()) return false;
                metrics.recordPoll(250); // auth + mutation, same estimate as other mutations
                if (superseded()) {
                    // This one may have changed the device; if the newer one is refused, only a
                    // poll shows the real state (review A2).
                    requestChargingPoll();
                    return false;
                }
                const result = parseBoostResponse(res);
                if (!result.ok && result.unclear) {
                    // Not clear whether it went through (review A2): do not flip the state or
                    // report a refusal; a charging poll reads what Octopus really did.
                    node.warn(`${label}: unclear answer from Octopus (${result.error}). Checking the boost state with a charging poll`);
                    node.status({ fill: "yellow", shape: "ring", text: `${label}: checking` });
                    if (typeof boosting === 'boolean') publishBoostSwitch(boosting); // re-sync HA
                    requestChargingPoll();
                    return false;
                }
                if (!result.ok) {
                    // Octopus refused: nothing changed on the device, so no forced poll.
                    fail(result.error);
                    noteBoostRefusal(enabled);
                    return false;
                }
                clearBoostRefusals();
                node.log(enabled ? "Boost requested" : "Boost cancelled");
                boostError = null;
                lastKnownState = mergePayload(lastKnownState, { boost_error: null });
                // Octopus accepted it, but its device state can lag behind (sweep #4): show the
                // requested state and hold it until a later poll agrees or BOOST_HOLD_MS passes,
                // so a stale read-back or poll cannot snap the switch back.
                const acceptedAt = Date.now();
                boostHold = { value: enabled, since: acceptedAt, until: acceptedAt + BOOST_HOLD_MS };
                if (typeof result.boosting === 'boolean' && result.boosting !== enabled) {
                    node.log(`${label} accepted. Octopus still reports ${result.currentState}, so the switch stays ${enabled ? "on" : "off"} while it catches up`);
                }
                applyBoosting(enabled);
                node.status({ fill: "green", shape: "dot", text: enabled ? "Boost requested" : "Boost cancelled" });
            } catch (e) {
                if (gone()) return false;
                if (superseded()) {
                    requestChargingPoll(); // it may still have reached Octopus
                    return false;
                }
                // No answer (e.g. a timeout): the request may still have reached Octopus.
                fail(e.message);
                requestChargingPoll();
                return false;
            }
            requestChargingPoll(); // poll soon so device state, charging_now and slots update
            return true;
        }

        function scheduleSmartChargingVerification(expectedSuspended, intervals, index) {
            if (nodeClosed) return;
            if (index >= intervals.length) {
                smartChargingVerifying = false; // the next charging poll reports the real state
                node.warn("Smart charging state could not be confirmed after all retries");
                node.status({ fill: "red", shape: "ring", text: "Smart charging: update unconfirmed" });
                return;
            }
            const timeout = setTimeout(async () => {
                try {
                    const authResponse = await graphqlPost({
                        query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                        variables: { input: { APIKey: apiKey } }
                    });
                    if (nodeClosed) return;
                    if (authResponse.data.errors || !authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                        scheduleSmartChargingVerification(expectedSuspended, intervals, index + 1);
                        return;
                    }
                    const token = authResponse.data.data.obtainKrakenToken.token;

                    const deviceResponse = await graphqlPost({
                        query: `query getDevices($accountNumber: String!) { devices(accountNumber: $accountNumber) { id deviceType status { isSuspended } } }`,
                        variables: { accountNumber: account }
                    }, token);
                    if (nodeClosed) return;

                    if (deviceResponse.data.errors || !deviceResponse.data.data) {
                        scheduleSmartChargingVerification(expectedSuspended, intervals, index + 1);
                        return;
                    }

                    const evDevice = intelligentCategory.extractEvDevice(deviceResponse.data.data.devices, preferredEvId);
                    if (!evDevice) {
                        scheduleSmartChargingVerification(expectedSuspended, intervals, index + 1);
                        return;
                    }

                    // Record verification API usage (auth + device query = ~200 complexity)
                    const ESTIMATED_VERIFICATION_COMPLEXITY = 200;
                    metrics.recordPoll(ESTIMATED_VERIFICATION_COMPLEXITY);

                    const actualSuspended = evDevice.status.isSuspended;
                    if (actualSuspended === expectedSuspended) {
                        // Confirmed — clear remaining retries
                        smartChargingSuspended = actualSuspended;
                        smartChargingVerifying = false;
                        publishSmartChargingState();
                        smartChargingRetryTimeouts.forEach(t => clearTimeout(t));
                        smartChargingRetryTimeouts = [];
                        node.log(`Smart charging confirmed: suspended=${actualSuspended}`);
                        node.status({ fill: "green", shape: "dot", text: actualSuspended ? "Smart charging suspended" : "Smart charging enabled" });
                    } else {
                        scheduleSmartChargingVerification(expectedSuspended, intervals, index + 1);
                    }
                } catch (e) {
                    if (nodeClosed) return;
                    node.warn(`Smart charging verification attempt ${index + 1} failed: ${short(e.message)}`);
                    scheduleSmartChargingVerification(expectedSuspended, intervals, index + 1);
                }
            }, intervals[index]);
            smartChargingRetryTimeouts.push(timeout);
        }

        // 6. Logic: Update Check (bespoke poll that ignores token)
        async function intelligentUpdateCheck(/* token ignored */) {
            return checkUpdate(httpGetJson, require('./package.json').version);
        }

        // 6. Logic: Intelligent Poll (single-scheduler bespoke poll)
        async function intelligentPoll(token, isStale) {
            const pollStartedAt = Date.now();
            deferredChargingPollAt = null; // this poll covers a deferred one
            const prefsGenAtStart = prefsGen;
            // 1. devices query
            const { query: devicesQuery, variables: devicesVars } = intelligentCategory.buildDevicesQuery(account);
            let devicesResponse = await graphqlPost({ query: devicesQuery, variables: devicesVars }, token);
            // Closed or superseded while waiting: don't send the dispatch query.
            if (nodeClosed || (isStale && isStale())) throw new Error('Poll superseded');
            // The device status is non-null inside a non-null list, so an error on it (e.g.
            // KT-CT-4360) nulls the whole device list. Ask once more without the status: the
            // preferences, Charge Cap and device id still come through, and the Smart Charging
            // switch keeps its last value.
            let statusUnavailable = false;
            if (intelligentCategory.statusNulledDevices(devicesResponse.data.errors, devicesResponse.data.data)) {
                const statusCode = errorCode(devicesResponse.data.errors.find((e) => errorCode(e))) || null;
                const retry = intelligentCategory.buildDevicesQuery(account, false);
                devicesResponse = await graphqlPost({ query: retry.query, variables: retry.variables }, token);
                if (nodeClosed || (isStale && isStale())) throw new Error('Poll superseded');
                statusUnavailable = true;
                if (!statusWarned) {
                    statusWarned = true;
                    node.warn(`Smart charging state unavailable${statusCode ? ` (${statusCode})` : ''} - keeping the last value until Octopus returns it`);
                }
            }
            // An error on the Charge Cap field alone (KT-CT-4360 pattern) or on the preferences
            // (KT-CT-4339; the same resolver backs both aliases) must not stop the slot updates:
            // keep the last confirmed values and still read the dispatches.
            const devicesData = devicesResponse.data.data || null;
            const hasDeviceList = !!devicesData && Array.isArray(devicesData.devices);
            // The query lists every device on the account. An error on another one (an inverter,
            // a second charger) says nothing about the EV, so it is left out (review A11): it
            // must not freeze the EV's switch, preferences and boost state.
            const polledEv = hasDeviceList ? intelligentCategory.extractEvDevice(devicesData.devices, preferredEvId) : null;
            const evIndex = polledEv ? devicesData.devices.indexOf(polledEv) : -1;
            const isOtherDeviceError = (e) => evIndex !== -1 && Array.isArray(e && e.path)
                && e.path[0] === 'devices' && Number.isInteger(e.path[1]) && e.path[1] !== evIndex;
            const allDevicesErrors = Array.isArray(devicesResponse.data.errors) ? devicesResponse.data.errors : null;
            const evDevicesErrors = allDevicesErrors ? allDevicesErrors.filter((e) => !isOtherDeviceError(e)) : null;
            if (allDevicesErrors && evDevicesErrors.length < allDevicesErrors.length && !otherDeviceErrorLogged) {
                otherDeviceErrorLogged = true; // once: it can repeat every poll
                const other = allDevicesErrors.find(isOtherDeviceError);
                node.log(`Charging poll: Octopus could not read another device on the account (${truncate(graphqlError([other]).message, 120)}). Ignored: it does not affect the EV`);
            }
            const devicesErrors = allDevicesErrors
                ? (evDevicesErrors.length > 0 ? evDevicesErrors : undefined)
                : devicesResponse.data.errors;
            const fieldErrorsOnly = onlyDeviceFieldErrors(devicesErrors, devicesData, TOLERATED_DEVICE_FIELDS);
            // Device list itself missing, but only because of a tolerated field (for example a
            // KT-CT-4339 that nulled the list, or the status error again on the ask without it):
            // the cached id still works.
            const toleratedNoList = !!devicesErrors && !hasDeviceList && !!krakenflexDeviceId
                && Array.isArray(devicesErrors) && devicesErrors.length > 0
                && devicesErrors.every((e) => errorCode(e) === PREFERENCES_ERROR_CODE
                    || (Array.isArray(e.path) && e.path[0] === 'devices' && TOLERATED_DEVICE_FIELDS.includes(e.path[2])));
            if (devicesErrors && !fieldErrorsOnly && !toleratedNoList) throw graphqlError(devicesErrors, 'Devices query failed');
            if (!devicesData) throw new Error('Devices response missing data');
            const fieldFailed = (f) => toleratedNoList
                || (fieldErrorsOnly && devicesErrors.some((e) => e.path[2] === f));
            const prefsFailed = fieldFailed('preferences');
            const chargeCapFailed = fieldFailed('chargeCap');
            // smartStatus carries isSuspended and currentState (boosting, device_state); both unknown
            // when the status errored or the poll asked again without it.
            const smartStatusFailed = statusUnavailable || fieldFailed('smartStatus');
            const suspended = hasDeviceList && !smartStatusFailed
                ? intelligentCategory.extractSuspended(devicesData.devices, preferredEvId) : null;
            if (!statusUnavailable && suspended !== null) statusWarned = false; // read again: warn on the next streak
            let deviceId = krakenflexDeviceId;
            if (hasDeviceList) {
                if (!polledEv) throw new Error('No ELECTRIC_VEHICLES device found on account');
                deviceId = polledEv.id;
                krakenflexDeviceId = deviceId;
            }

            // 2. dispatches query (the single one that used to be duplicated by V1 + V2)
            const { query: dispatchQuery, variables: dispatchVars } = intelligentCategory.buildDispatchQuery(deviceId);
            noteDispatchQuery();
            const dispatchResponse = await graphqlPost({ query: dispatchQuery, variables: dispatchVars }, token);
            if (dispatchResponse.data.errors) throw graphqlError(dispatchResponse.data.errors, 'Dispatches query failed');
            if (!dispatchResponse.data.data) throw new Error('Dispatches response missing data');

            // 3. parse twice — intelligent (slots/window) + flex-planned-dispatches (array/count)
            const data = { devices: hasDeviceList ? devicesData.devices : [], flexPlannedDispatches: dispatchResponse.data.data.flexPlannedDispatches || [] };
            const appliedTz = resolveTimezone(node);
            const serverTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
            const catResult = intelligentCategory.parseResponse(data, { tz: appliedTz, serverTz, evId: preferredEvId });
            const { _activeSlots, ...catPublic } = catResult;
            if (chargeCapFailed) delete catPublic.charge_cap; // unknown this poll: keep the last value
            if (prefsFailed) {
                // parseResponse fell back to defaults: keep the last confirmed schedule instead.
                delete catPublic.confirmed_limit;
                delete catPublic.confirmed_time;
            }
            if (smartStatusFailed || catPublic.boosting === null) delete catPublic.boosting; // unknown: keep the last value
            if (smartStatusFailed || catPublic.device_state === null) delete catPublic.device_state; // same source as boosting
            const flexResult = flexPlannedDispatchesCategory.parseResponse(dispatchResponse.data.data);

            // A late answer from a closed node or a superseded poll must not reset timers.
            if (nodeClosed || (isStale && isStale())) throw new Error('Poll superseded');

            // A change was sent or confirmed while this poll waited: its target, ready-by time
            // and Charge Cap are older than that. Keep the dispatches, drop those values and read
            // again on the next tick.
            const prefsStale = prefsGen !== prefsGenAtStart;
            if (prefsStale) {
                delete catPublic.confirmed_limit;
                delete catPublic.confirmed_time;
                delete catPublic.charge_cap;
                forceCategoryDue('intelligent');
            }

            // 4. metrics + side effects
            noteChargingPollSuccess();
            metrics.recordPoll(300);
            if (!prefsFailed && !prefsStale) {
                confirmedLimit = catResult.confirmed_limit ?? confirmedLimit;
                confirmedTime = catResult.confirmed_time || confirmedTime;
            }
            if (!validationMode && !prefsStale) {
                pendingLimit = confirmedLimit;
                pendingTime = confirmedTime;
            }
            if (prefsFailed) {
                // One line covers both aliases (they share the preferences resolver).
                const code = errorCode(devicesErrors[0]);
                node.warn(`Charging preferences unavailable this poll${code ? ` (${code})` : ''} - keeping ${confirmedLimit}% @ ${confirmedTime}`);
            }
            if (prefsStale) {
                // The Charge Cap switch keeps what the newer change set.
            } else if (chargeCapFailed) {
                if (!prefsFailed) node.warn("Charge Cap state unavailable this poll — keeping the last known value");
            } else if (typeof catResult.charge_cap === 'boolean') {
                if (enableMqtt && node.broker && node.broker.client) {
                    node.broker.client.publish(`${stateTopic}/charge_cap`, catResult.charge_cap ? "ON" : "OFF", { retain: true });
                }
            } else if (!chargeCapNaWarned) {
                chargeCapNaWarned = true;
                node.warn("Charge Cap not applicable for this device — switch will show unknown");
            }
            // Smart charging changed outside the node (e.g. in the Octopus app). A toggle still
            // waiting for confirmation wins: Octopus can report the old state for a while.
            if (suspended !== null && !smartChargingVerifying) {
                smartChargingSuspended = suspended;
                publishSmartChargingState();
            }
            if (typeof catPublic.boosting === 'boolean') {
                // The device state was read: an old boost refusal no longer applies.
                if (boostError !== null && pollStartedAt >= boostErrorAt + BOOST_ERROR_CLEAR_MS) boostError = null;
                // A set_boost Octopus accepted is held until a poll sent after it agrees, or
                // until BOOST_HOLD_MS has passed; then the poll wins (as smartChargingVerifying).
                if (boostHold) {
                    const agrees = catPublic.boosting === boostHold.value;
                    if (agrees && pollStartedAt >= boostHold.since) {
                        boostHold = null;
                    } else if (Date.now() >= boostHold.until) {
                        if (!agrees) node.log(`Octopus still reports boosting=${catPublic.boosting} ${Math.round(BOOST_HOLD_MS / 60000)} min after the boost change: showing what Octopus reports`);
                        boostHold = null;
                    } else {
                        catPublic.boosting = boostHold.value;
                    }
                }
                boosting = catPublic.boosting;
                boostingConfirmedAt = Date.now();
                publishBoostSwitch(boosting);
            }
            checkUnconfirmedWrites(catResult.charge_cap, !prefsFailed && !prefsStale, !chargeCapFailed && !prefsStale);
            setupChargingTimers(_activeSlots); // charging_now = slot active OR boosting
            if (!stateCheckInterval) startStateReconciliation();
            updateNextPollTime();

            const apiMetrics = metrics.getMetrics();

            // 5. merged partial payload (no pending values from a poll whose preferences are stale)
            const pending = prefsStale ? {} : { pending_limit: pendingLimit, pending_time: pendingTime };
            return Object.assign({}, catPublic, flexResult, pending, {
                charging_now: chargingNow,
                next_poll: nextPollTime,
                next_poll_raw: nextPollTime,
                refresh_available_at: getRefreshAvailableAt(),
                api_requests_hour: apiMetrics.requests_last_hour,
                api_complexity_hour: apiMetrics.complexity_last_hour,
                api_complexity_percent: parseFloat(apiMetrics.complexity_percent),
                timezone_detected: serverTz,
                timezone_applied: appliedTz,
                smart_charging: smartChargingSuspended === null ? null : !smartChargingSuspended,
                boost_error: boostError,
            });
        }


        // Helper: Fetch device ID and initial smart charging state (called once at startup)
        async function fetchDeviceId() {
            try {
                const authResponse = await graphqlPost({
                    query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                    variables: { input: { APIKey: apiKey } }
                });
                if (nodeClosed) return; // closed while waiting: send nothing more
                if (authResponse.data.errors || !authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                    throw new Error(`Auth failed: ${JSON.stringify(authResponse.data.errors)}`);
                }
                const token = authResponse.data.data.obtainKrakenToken.token;

                const deviceResponse = await graphqlPost({
                    query: `query getDevices($accountNumber: String!) { devices(accountNumber: $accountNumber) { id deviceType status { isSuspended } } }`,
                    variables: { accountNumber: account }
                }, token);
                if (nodeClosed) return; // closed while waiting: no publish, no log

                if (deviceResponse.data.errors || !deviceResponse.data.data) {
                    throw new Error(`Device fetch failed: ${JSON.stringify(deviceResponse.data.errors)}`);
                }

                const evDevice = intelligentCategory.extractEvDevice(deviceResponse.data.data.devices, preferredEvId);
                if (!evDevice) {
                    throw new Error('No ELECTRIC_VEHICLES device found on account');
                }

                krakenflexDeviceId = evDevice.id;
                if (evDevice.status && typeof evDevice.status.isSuspended === 'boolean') {
                    smartChargingSuspended = evDevice.status.isSuspended;
                    publishSmartChargingState();
                }
                node.log(`Device ID cached: ${krakenflexDeviceId}, suspended: ${smartChargingSuspended}`);
            } catch (e) {
                if (nodeClosed) return;
                // Keep whatever discovery or a charging poll has found meanwhile.
                node.warn(`Failed to fetch device ID at startup: ${short(e.message)}. Smart charging toggle unavailable until the first charging poll.`);
            }
        }

        // 6a. Charging Now - Timer Management Functions

        // State reconciliation - checks every 10s if charging state matches reality
        // A boost counts as charging, so it is never corrected back to false (lib/boost.js).
        function reconcileChargingState() {
            expireStaleBoosting();
            const shouldBeCharging = reconcileChargingNow({ slots: cachedSlots, boosting, chargingNow });
            if (shouldBeCharging !== null) {
                node.warn(`State reconciliation: Correcting chargingNow from ${chargingNow} to ${shouldBeCharging}`);
                publishChargingState(shouldBeCharging);
            }
        }

        // Sweep #5: boosting is only as good as the last time Octopus confirmed it. With no
        // confirmation for 2 charging-poll intervals (an outage, repeated status errors) it is
        // unknown, so a boost that ended long ago cannot hold charging_now on for ever.
        function boostingTtlMs() {
            const cat = categories.find((c) => c.id === 'intelligent');
            return 2 * (cat ? cat.intervalMs : refreshRate);
        }

        function expireStaleBoosting() {
            if (boosting === null || !boostingConfirmedAt) return;
            const age = Date.now() - boostingConfirmedAt;
            if (age <= boostingTtlMs()) return;
            const text = `Boost state not confirmed by Octopus for ${formatDuration(age)}: treating it as unknown`;
            if (boosting === true) node.warn(text); else node.log(text);
            boosting = null;
            boostHold = null;
            lastKnownState = mergePayload(lastKnownState, { boosting: null });
            // The HA Boost switch shows unknown too, not its last ON or OFF (review A7).
            publishBoostSwitch(null);
            const shouldBeCharging = chargingNowFor(cachedSlots, null);
            if (shouldBeCharging !== chargingNow) publishChargingState(shouldBeCharging);
        }

        // Saving session / free electricity / current rate flags change at their start and end
        // times, not when the category is polled. Recompute them from the stored data (no API
        // call) and publish only when a value changed.
        function refreshActiveFields() {
            if (nodeClosed) return;
            const changed = changedActiveFields(lastKnownState, Date.now());
            if (!changed) return;
            lastKnownState = mergePayload(lastKnownState, changed);
            if (enableMqtt && node.broker && node.broker.client) {
                node.broker.client.publish(stateTopic, stateJson(lastKnownState), { retain: true });
            }
            node.send({
                payload: lastKnownState,
                debug: { timestamp: new Date().toISOString(), trigger: 'active_fields_change', changed: Object.keys(changed) },
            });
        }

        // Start state reconciliation loop (every 10 seconds)
        function startStateReconciliation() {
            if (nodeClosed) return; // a late callback must not leave an interval on a closed node
            // Clear existing interval
            if (stateCheckInterval) {
                clearInterval(stateCheckInterval);
            }

            // Check state every 10 seconds
            stateCheckInterval = setInterval(() => {
                reconcileChargingState();
                refreshActiveFields();
            }, 10000);

            node.log("State reconciliation loop started (every 10s)");
        }

        // Clear all charging timers
        function clearChargingTimers() {
            if (preValidationTimer) {
                clearTimeout(preValidationTimer);
                preValidationTimer = null;
            }
            if (slotStartTimer) {
                clearTimeout(slotStartTimer);
                slotStartTimer = null;
            }
            if (slotEndTimer) {
                clearTimeout(slotEndTimer);
                slotEndTimer = null;
            }
            if (stateCheckInterval) {
                clearInterval(stateCheckInterval);
                stateCheckInterval = null;
            }
        }

        // Manual refresh rate limiting helpers
        function canManualRefresh() {
            const now = Date.now();
            const timeSinceLastRefresh = now - lastManualRefresh;
            return lastManualRefresh === 0 || timeSinceLastRefresh >= MANUAL_REFRESH_COOLDOWN;
        }

        function getSecondsUntilNextRefresh() {
            const now = Date.now();
            const timeSinceLastRefresh = now - lastManualRefresh;
            const timeRemaining = MANUAL_REFRESH_COOLDOWN - timeSinceLastRefresh;
            return Math.max(0, Math.ceil(timeRemaining / 1000));
        }

        function getRefreshAvailableAt() {
            const now = Date.now();
            const timeSinceLastRefresh = now - lastManualRefresh;

            // If never refreshed OR cooldown expired, ready now
            if (lastManualRefresh === 0 || timeSinceLastRefresh >= MANUAL_REFRESH_COOLDOWN) {
                return null;  // Ready - no cooldown
            }

            // Cooldown active - return timestamp when it expires
            return new Date(lastManualRefresh + MANUAL_REFRESH_COOLDOWN).toISOString();
        }

        function publishRefreshCooldownState() {
            if (enableMqtt && node.broker) {
                const fullState = {
                    ...lastKnownState,
                    refresh_available_at: getRefreshAvailableAt()
                };
                node.broker.client.publish(stateTopic, stateJson(fullState), { retain: true });
            }
        }

        // Polling metrics helpers
        function updateNextPollTime() {
            nextPollTime = new Date(Date.now() + refreshRate).toISOString();
        }

        // Retained charging_now topic for the Home Assistant binary_sensor
        function publishChargingNowTopic(state) {
            chargingNowPublished = true;
            if (enableMqtt && node.broker && node.broker.client) {
                node.broker.client.publish(`${stateTopic}/charging_now`, state ? "ON" : "OFF", { retain: true });
            }
        }

        // Publish charging state to MQTT and Node-RED
        function publishChargingState(state) {
            chargingNow = state;
            // Keep the JSON state in step, so every later message and publish carries it.
            lastKnownState = mergePayload(lastKnownState, { charging_now: state });

            // Update MQTT
            publishChargingNowTopic(state);

            // Output message to Node-RED flow if state actually changed
            if (lastSentChargingState !== state) {
                lastSentChargingState = state;

                // Merge updated charging_now into last known full state
                const outputPayload = {
                    ...lastKnownState,
                    charging_now: state
                };

                node.send({
                    payload: outputPayload,
                    debug: {
                        timestamp: new Date().toISOString(),
                        trigger: 'charging_state_change',
                        success: true,
                        previous_state: !state,
                        new_state: state
                    }
                });

                node.log(`Charging state changed: ${!state} → ${state}, message sent`);
            }
        }

        // Setup pre-validation timer (30s before slot starts)
        function setupPreValidationTimer(nextSlot) {
            if (nodeClosed) return;
            const now = new Date();
            const slotStart = new Date(nextSlot.start);
            const preValidationTime = slotStart.getTime() - 30000; // 30s before
            const msUntilPreValidation = preValidationTime - now.getTime();

            if (msUntilPreValidation > 0 && msUntilPreValidation < 24 * 60 * 60 * 1000) { // Within 24 hours
                preValidationTimer = setTimeout(async () => {
                    if (nodeClosed) return;
                    node.warn("Pre-validating slot data (30s before start)");
                    try {
                        if (!krakenflexDeviceId) {
                            throw new Error("Device ID not available for pre-validation");
                        }

                        const authResponse = await graphqlPost({
                            query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                            variables: { input: { APIKey: apiKey } }
                        });

                        if (nodeClosed) return;
                        if (!authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                            throw new Error("Pre-validation auth failed");
                        }

                        const token = authResponse.data.data.obtainKrakenToken.token;

                        const { query: dq, variables: dv } = intelligentCategory.buildDispatchQuery(krakenflexDeviceId);
                        noteDispatchQuery(); // counts toward the retry rate limit
                        const dataResponse = await graphqlPost({ query: dq, variables: dv }, token);
                        if (nodeClosed) return;
                        // Kraken fails with HTTP 200, GraphQL errors and null data (e.g. KT-CT-4340):
                        // a failed check, so fall back to the cached slot below.
                        if (dataResponse.data.errors) throw graphqlError(dataResponse.data.errors, 'Dispatches query failed');
                        if (!dataResponse.data.data || !dataResponse.data.data.flexPlannedDispatches) {
                            throw new Error('Dispatches response missing data');
                        }

                        const freshSlots = dataResponse.data.data.flexPlannedDispatches;
                        // Octopus re-planned since the last poll: poll now so the slot/window
                        // sensors match what charging_now is about to do.
                        if (intelligentCategory.slotsChanged(cachedSlots, freshSlots)) {
                            node.warn("Charging plan changed since last poll - refreshing");
                            forceCategoryDue('intelligent');
                        }
                        cachedSlots = freshSlots;

                        // Record pre-validation API usage (auth + simple query = ~200 complexity)
                        const ESTIMATED_PREVALIDATION_COMPLEXITY = 200;
                        metrics.recordPoll(ESTIMATED_PREVALIDATION_COMPLEXITY);

                        // Check if slot still exists (within 1 minute tolerance)
                        const stillExists = cachedSlots.find(s =>
                            Math.abs(new Date(s.start).getTime() - slotStart.getTime()) < 60000
                        );

                        if (stillExists) {
                            node.warn(`Slot confirmed at ${stillExists.start}`);
                            setupSlotStartTimer(stillExists);
                        } else {
                            // Cancel the start timer armed from the known plan.
                            if (slotStartTimer) { clearTimeout(slotStartTimer); slotStartTimer = null; }
                            node.warn("Slot was cancelled or modified - not setting start timer");
                        }
                    } catch (error) {
                        if (nodeClosed) return;
                        node.warn(`Pre-validation failed: ${short(error.message)}, using cached slot`);
                        // Fallback: use original slot data
                        setupSlotStartTimer(nextSlot);
                    }
                }, msUntilPreValidation);

                const minutesUntil = Math.round(msUntilPreValidation / 60000);
                node.log(`Pre-validation timer set for ${minutesUntil} min before slot start`);
                // Arm the start from the known plan now. Pre-validation makes two requests of up to
                // 30 s each; if they are still running at the slot start, the slot starts on time
                // anyway. Pre-validation then moves the timer (slot confirmed) or cancels it.
                setupSlotStartTimer(nextSlot);
            } else if (msUntilPreValidation <= 0 && slotStart.getTime() > now.getTime()) {
                // Polled inside the last 30s (e.g. the refresh after a re-plan): the data is
                // already fresh, so set the start timer directly instead of losing it.
                setupSlotStartTimer(nextSlot);
            }
        }

        // Setup slot start timer (exact start time)
        function setupSlotStartTimer(slot) {
            if (nodeClosed) return;
            // A poll and an in-flight pre-validation can both set this; never leave an orphan.
            if (slotStartTimer) { clearTimeout(slotStartTimer); slotStartTimer = null; }
            const now = new Date();
            const slotStart = new Date(slot.start);
            const msUntilStart = slotStart.getTime() - now.getTime();

            if (msUntilStart > 0 && msUntilStart < 24 * 60 * 60 * 1000) { // Within 24 hours
                slotStartTimer = setTimeout(() => {
                    publishChargingState(true);
                    node.warn(`Charging slot started at ${slot.start}`);
                    setupSlotEndTimer(slot);
                }, msUntilStart);

                const secondsUntil = Math.round(msUntilStart / 1000);
                node.log(`Slot start timer set for ${secondsUntil}s (${slot.start})`);
            } else if (msUntilStart <= 0) {
                // Slot already started, check if it's still active
                const slotEnd = new Date(slot.end);
                if (slotEnd > now) {
                    // Already on when the start timer armed from the known plan has fired.
                    if (!chargingNow) publishChargingState(true);
                    setupSlotEndTimer(slot);
                }
            }
        }

        // Setup slot end timer (exact end time)
        function setupSlotEndTimer(slot) {
            if (nodeClosed) return;
            if (slotEndTimer) { clearTimeout(slotEndTimer); slotEndTimer = null; }
            const now = new Date();
            const slotEnd = new Date(slot.end);
            const msUntilEnd = slotEnd.getTime() - now.getTime();

            if (msUntilEnd > 0 && msUntilEnd < 24 * 60 * 60 * 1000) { // Within 24 hours
                slotEndTimer = setTimeout(() => {
                    node.warn(`Charging slot ended at ${slot.end}`);

                    // Check if another slot starts immediately (within cached data)
                    const now = new Date();
                    const immediateNextSlot = cachedSlots.find(s => {
                        const start = new Date(s.start);
                        const end = new Date(s.end);
                        return start <= now && end > now;
                    });

                    if (immediateNextSlot) {
                        node.warn("Next slot starting immediately");
                        publishChargingState(true);
                        setupSlotEndTimer(immediateNextSlot);
                    } else {
                        publishChargingState(boosting === true); // a boost keeps charging_now on
                    }
                }, msUntilEnd);

                const minutesUntil = Math.round(msUntilEnd / 60000);
                node.log(`Slot end timer set for ${minutesUntil} min (${slot.end})`);
            }
        }

        // Main timer setup - called on each poll
        function setupChargingTimers(slots) {
            if (nodeClosed) return;
            // Clear existing timers
            clearChargingTimers();

            // Cache slots for later use
            cachedSlots = slots;

            const now = new Date();

            // Check if currently in a charging slot
            const activeSlot = slots.find(s => {
                const start = new Date(s.start);
                const end = new Date(s.end);
                return start <= now && end > now;
            });

            if (activeSlot) {
                // Currently charging
                const newState = true;
                if (chargingNow !== newState) {
                    publishChargingState(newState);
                }
                setupSlotEndTimer(activeSlot);
                node.log("Currently charging - end timer set");
            } else {
                // No slot active: charging only if a boost is running
                const newState = boosting === true;
                if (chargingNow !== newState) {
                    publishChargingState(newState);
                } else if (!chargingNowPublished) {
                    // First poll since start: overwrite a retained ON left from before a restart.
                    publishChargingNowTopic(newState);
                }

                // Find next future slot
                const nextSlot = slots.find(s => new Date(s.start) > now);

                if (nextSlot) {
                    setupPreValidationTimer(nextSlot);
                    node.log(`Next slot at ${nextSlot.start}`);
                }
            }
        }

        // 7. Event Listeners

        // Helper: Publish current state (both pending and confirmed)
        // This merges pending values into last known full state to prevent sensors going unknown
        function publishCurrentState() {
            if (enableMqtt && node.broker) {
                // Merge pending values into last known state
                const fullState = {
                    ...lastKnownState,
                    pending_limit: pendingLimit,
                    pending_time: pendingTime,
                    confirmed_limit: confirmedLimit,
                    confirmed_time: confirmedTime
                };
                node.broker.client.publish(stateTopic, stateJson(fullState), { retain: false });
            }
        }

        // A. Handle Node-RED Input Messages (NO rate limiting - programmers control this)
        node.on('input', function (msg) {
            // Check for control commands (preference updates)
            if (msg.payload && typeof msg.payload === 'object') {
                const plan = planCommands(msg.payload, { confirmedLimit, confirmedTime });
                plan.errors.forEach((e) => node.error(e, msg));
                if (plan.errors.length && !plan.actions.length) {
                    node.status({ fill: "red", shape: "ring", text: plan.errors[0].split(' —')[0] });
                }
                for (const a of plan.actions) {
                    if (a.type === 'preferences') setPreferences(a.limit, a.time);
                    else if (a.type === 'timezone') {
                        node.context().set('timezone', a.timezone);
                        node.log(`Timezone set to: ${a.timezone}`);
                    }
                    else if (a.type === 'smart_charging') setSmartCharging(a.enabled);
                    else if (a.type === 'charge_cap') setChargeCap(a.enabled);
                    else if (a.type === 'boost') requestBoost(a.enabled);
                }
                if (plan.hasCommand) return; // commands never trigger a manual refresh
            }

            // Manual refresh request from Node-RED - NO rate limiting
            // (Programmers can control rate limiting in their flows if needed)
            // Update timestamp so HA sees cooldown, but don't block the refresh
            lastManualRefresh = Date.now();
            node.status({ fill: "yellow", shape: "ring", text: "Manual refresh..." });
            forceCategoryDue('intelligent');
        });

        // B. Handle MQTT Commands (Home Assistant)
        if (enableMqtt && node.broker) {
            node.broker.register(this);

            // Subscribe with this node's id as the ref so close can remove exactly these
            // subscriptions (Node-RED broker API: subscribe(topic, options, callback, ref)).
            const subscribeCommand = (topic, callback) => node.broker.subscribe(topic, 0, callback, node.id);

            // Action commands (they write to Octopus or force a poll) ignore retained messages.
            // The broker replays a retained message on every restart, redeploy and reconnect, so
            // a retained ON on set_boost would boost again each time. Home Assistant publishes
            // these without retain; a live publish reaches the node with the retain flag off.
            const retainedWarned = new Set();
            const subscribeAction = (topic, callback) => subscribeCommand(topic, (t, payload, packet) => {
                if (packet && packet.retain === true) {
                    if (!retainedWarned.has(topic)) {
                        retainedWarned.add(topic);
                        node.warn(`Ignored a retained message on ${topic}. Commands are never taken from retained messages. Clear it by publishing an empty retained message to that topic.`);
                    }
                    return;
                }
                callback(t, payload, packet);
            });

            // Slider changed - update pending value only
            subscribeCommand(cmdTopicLimit, (topic, payload) => {
                const r = validateLimit(payload.toString());
                if (!r.ok) {
                    node.warn(r.error);
                    publishCurrentState(); // snap slider back
                    return;
                }
                pendingLimit = r.limit;
                publishCurrentState(); // Update display immediately
                node.status({ fill: "yellow", shape: "dot", text: `Pending: ${pendingLimit}% @ ${pendingTime}` });
            });

            // Dropdown changed - update pending value only
            subscribeCommand(cmdTopicTime, (topic, payload) => {
                const r = validateTime(payload.toString());
                if (!r.ok) {
                    node.warn(r.error);
                    publishCurrentState(); // snap dropdown back
                    return;
                }
                pendingTime = r.time;
                publishCurrentState(); // Update display immediately
                node.status({ fill: "yellow", shape: "dot", text: `Pending: ${pendingLimit}% @ ${pendingTime}` });
            });

            // Button pressed - submit changes to API
            subscribeAction(cmdTopicSubmit, (topic, payload) => {
                setPreferences(pendingLimit, pendingTime);
            });

            // Refresh button pressed - MQTT has hardcoded 30s rate limiting
            subscribeAction(cmdTopicRefresh, (topic, payload) => {
                // Check rate limit (only for MQTT button)
                if (!canManualRefresh()) {
                    const secondsRemaining = getSecondsUntilNextRefresh();
                    node.status({
                        fill: "red",
                        shape: "dot",
                        text: `Cooldown: ${secondsRemaining}s`
                    });
                    node.warn(`MQTT refresh blocked. Please wait ${secondsRemaining} seconds.`);
                    return;  // Block the refresh
                }

                // Refresh allowed - set cooldown timestamp
                lastManualRefresh = Date.now();

                // Publish immediate update with countdown timestamp
                publishRefreshCooldownState();

                // Schedule cleanup at exactly 30 seconds to clear countdown
                if (cooldownExpiryTimer) clearTimeout(cooldownExpiryTimer);
                cooldownExpiryTimer = setTimeout(() => {
                    // Cooldown expired - publish null to clear countdown in HA
                    publishRefreshCooldownState();
                    cooldownExpiryTimer = null;
                }, MANUAL_REFRESH_COOLDOWN);

                // Trigger the actual refresh
                node.status({ fill: "yellow", shape: "ring", text: "Manual refresh..." });
                forceCategoryDue('intelligent');
            });

            // Timezone select changed in Home Assistant
            subscribeCommand(cmdTopicTimezone, (topic, payload) => {
                const text = payload.toString();
                if (text.trim().length === 0) return; // empty: ignored
                const r = validateTimezone(text);
                if (!r.ok) {
                    node.error(r.error); // nothing stored or published
                    return;
                }
                node.context().set('timezone', r.timezone);
                node.log(`Timezone set via MQTT to: ${r.timezone}`);
                node.broker.client.publish(`${stateTopic}/timezone`, r.timezone, { retain: true });
            });

            // Smart charging switch toggled in Home Assistant
            subscribeAction(cmdTopicSmartCharging, (topic, payload) => {
                const val = payload.toString().trim();
                if (val === "ON") setSmartCharging(true);
                else if (val === "OFF") setSmartCharging(false);
            });

            // Charge Cap switch toggled in HA
            subscribeAction(cmdTopicChargeCap, (topic, payload) => {
                const val = payload.toString().trim();
                if (val === "ON") setChargeCap(true);
                else if (val === "OFF") setChargeCap(false);
            });

            // Boost Charge switch toggled in HA
            subscribeAction(cmdTopicBoost, (topic, payload) => {
                const val = payload.toString().trim();
                if (val === "ON") requestBoost(true);
                else if (val === "OFF") requestBoost(false);
                else node.warn(`Ignored set_boost command '${truncate(val, 40)}': send ON or OFF`);
            });

            initTimeout(announceControls, 2000);

            // Republish persisted timezone to HA select on startup
            initTimeout(() => {
                try {
                    const persistedTz = node.context().get('timezone');
                    if (persistedTz && node.broker) {
                        node.broker.client.publish(`${stateTopic}/timezone`, persistedTz, { retain: true });
                    }
                } catch (e) { node.warn('Failed to republish timezone on startup: ' + e.message); }
            }, 2500);

            // The smart charging switch state is published by the startup device fetch,
            // discovery and every charging poll as soon as each one knows it.
        }

        // Init
        initTimeout(fetchDeviceId, 1500);

        // V2 category discovery and scheduler. Retries with backoff until discovery succeeds
        // (a transient Kraken error at startup used to leave the node with no scheduler until
        // restart). Tracked + nodeClosed-guarded so a redeploy can never leave an orphan
        // scheduler or retry timer.
        async function startV2(attempt) {
            if (nodeClosed) return;
            try {
                const discovered = await discoverProducts(apiKey, account, { isClosed: () => nodeClosed });
                if (nodeClosed) return;
                applyDiscoveredSuspended(discovered);
                await initCategories(discovered);
                if (nodeClosed) return;
                announceSmartflexEntities(discovered);
                node.log(`V2 discovery: electricity=${discovered.hasElectricity}, gas=${discovered.hasGas}, intelligent=${discovered.hasIntelligent}, suspended=${discovered.deviceSuspended}, vehicle=${!!discovered.vehicleDeviceId}, inverter=${!!discovered.inverterDeviceId}${discovered.inverterDeviceId && config.enableSmartflexInverter !== true ? ' (inverter option off)' : ''}`);
                const v2Scheduler = createScheduler(pollDueCategories, {
                    onStuck: (ms) => node.warn(`Poll still running after ${Math.round(ms / 1000)}s - starting a new poll`),
                });
                v2Scheduler.start();
                node._v2Scheduler = v2Scheduler;
                // The 10 s tick also keeps the "active now" fields current, so run it on
                // accounts without a charger too (the charging poll restarts it with its timers).
                if (!stateCheckInterval) startStateReconciliation();
                // An empty device list can be transient: check again before giving up on a charger.
                if (!discovered.hasIntelligent && discovered.deviceCount === 0) scheduleDeviceCheck(0);
            } catch (e) {
                if (nodeClosed) return;
                const delay = discoveryRetryDelay(attempt);
                const secs = Math.round(delay / 1000);
                node.warn(`V2 discovery failed: ${short(e.message)}. Retrying in ${secs}s.`);
                node.status({ fill: "yellow", shape: "ring", text: `Discovery failed — retrying in ${secs}s` });
                initTimeout(() => startV2(attempt + 1), delay);
            }
        }
        initTimeout(() => startV2(0), 2000);

        function applyDiscoveredSuspended(discovered) {
            // The EV discovery chose (the LIVE one when several are listed): later polls read it.
            preferredEvId = discovered.deviceId || null;
            // The startup device fetch can fail (it has no tolerance for a status error) and so
            // can the first charging poll. Discovery found the device: the switch, Charge Cap and
            // preference writes can use it until a charging poll reads it again. It also replaces
            // an id the startup fetch found: that fetch runs before preferredEvId is known and
            // takes the first EV listed, which can be a RETIRED one.
            if (discovered.deviceId) krakenflexDeviceId = discovered.deviceId;
            // Discovery had to ask again without the device status: one warning, shared with the
            // charging poll's, until the state is read again.
            if (discovered.statusErrorCode !== undefined && !statusWarned && !nodeClosed) {
                statusWarned = true;
                const code = discovered.statusErrorCode;
                node.warn(`Smart charging state unavailable${code ? ` (${code})` : ''} - keeping the last value until Octopus returns it`);
            }
            if (discovered.deviceSuspended !== null && discovered.deviceSuspended !== undefined) {
                smartChargingSuspended = discovered.deviceSuspended;
                lastKnownState = mergePayload(lastKnownState, { smart_charging: !discovered.deviceSuspended });
                publishSmartChargingState();
            }
        }

        // Discovery found no devices at all (devices: []), which can be transient. Check again
        // on the discovery retry delays, at most EMPTY_DEVICES_MAX_RETRIES times. `done` is the
        // number of checks made so far. The other categories keep polling meanwhile.
        function scheduleDeviceCheck(done) {
            if (nodeClosed) return;
            if (done >= EMPTY_DEVICES_MAX_RETRIES) {
                node.log(`No charging device found after ${done} checks - charging polls stay off until the node restarts`);
                return;
            }
            const delay = discoveryRetryDelay(done);
            node.log(`V2 discovery found no devices - checking again in ${Math.round(delay / 1000)}s`);
            initTimeout(() => checkDevicesAgain(done + 1), delay);
        }

        async function checkDevicesAgain(done) {
            if (nodeClosed) return;
            let discovered;
            try {
                discovered = await discoverProducts(apiKey, account, { isClosed: () => nodeClosed });
            } catch (e) {
                if (nodeClosed) return;
                node.warn(`Device check failed: ${short(e.message)}`);
                scheduleDeviceCheck(done);
                return;
            }
            if (nodeClosed) return;
            if (!discovered.hasIntelligent) {
                // Still empty: check again. Devices but no EV: that is the answer.
                if (discovered.deviceCount === 0) scheduleDeviceCheck(done);
                return;
            }
            if (categories.some((c) => c.id === 'intelligent')) return;
            applyDiscoveredSuspended(discovered);
            // Added in place: the other categories keep their schedule. The same set as a
            // normal start (deviceCategoryEntries), then the SmartFlex entities (review4 #1).
            const deviceCategories = deviceCategoryEntries(discovered);
            const isNew = (entry) => !categories.some((c) => c.id === entry.id);
            categories.unshift(...deviceCategories.lead.filter(isNew));
            categories.push(...deviceCategories.rest.filter(isNew));
            announceSmartflexEntities(discovered);
            node.log(`V2 discovery: charging device found on check ${done} - charging polls started`);
        }

        // Node-RED passes (removed, done) to a two-argument close handler; a caller that
        // passes only done is also handled.
        node.on('close', function (removed, done) {
            if (typeof removed === 'function') { done = removed; removed = false; }
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                if (typeof done === 'function') done();
            };
            nodeClosed = true;
            // Retries are tick-driven; dropping the outage state stops any pending one.
            chargingOutage = null;
            retryPollRunning = false;
            // Clear init setTimeouts so a redeploy during warmup can't leave an orphan scheduler
            initTimeoutHandles.forEach(h => clearTimeout(h));
            initTimeoutHandles.clear();
            // Clear any pending retry timeouts
            retryTimeouts.forEach(timeout => clearTimeout(timeout));
            retryTimeouts = [];
            // Clear smart charging retry timeouts
            smartChargingRetryTimeouts.forEach(t => clearTimeout(t));
            smartChargingRetryTimeouts = [];
            // Drop a boost request still waiting for its turn
            if (boostQueue.timer) { clearTimeout(boostQueue.timer); boostQueue.timer = null; }
            if (boostQueue.watchdog) { clearTimeout(boostQueue.watchdog); boostQueue.watchdog = null; }
            boostQueue.pending = null;
            deferredChargingPollAt = null;
            // Clear charging timers
            clearChargingTimers();
            // Clear cooldown expiry timer
            if (cooldownExpiryTimer) {
                clearTimeout(cooldownExpiryTimer);
                cooldownExpiryTimer = null;
            }
            if (node._v2Scheduler) node._v2Scheduler.stop();
            // Remove only this node's command subscriptions, then deregister from the broker
            // (unsubscribe(topic, ref, removeClientSubscription); deregister(node, done, autoDisconnect)).
            if (enableMqtt && node.broker) {
                try {
                    for (const topic of commandTopics) node.broker.unsubscribe(topic, node.id, true);
                } catch (e) {
                    node.warn(`MQTT unsubscribe failed: ${e.message}`);
                }
                if (typeof node.broker.deregister === 'function') {
                    try {
                        node.broker.deregister(node, finish, removed);
                        return;
                    } catch (e) {
                        node.warn(`MQTT deregister failed: ${e.message}`);
                    }
                }
            }
            finish();
        });
    }

    RED.nodes.registerType("octopus-intelligent", OctopusIntelligentNode, {
        credentials: { apiKey: { type: "password" } }
    });
};