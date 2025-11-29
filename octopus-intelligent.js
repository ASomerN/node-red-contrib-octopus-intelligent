const axios = require("axios");

module.exports = function (RED) {
    function OctopusIntelligentNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // 1. Configuration
        const account = config.accountNumber ? config.accountNumber.trim() : "";
        const apiKey = this.credentials.apiKey ? this.credentials.apiKey.trim() : "";
        const refreshRate = (config.refreshInterval || 5) * 60 * 1000;
        const enableMqtt = config.enableMqtt;

        // MQTT Topics
        this.broker = RED.nodes.getNode(config.broker);
        const mqttPrefix = `homeassistant`;
        const uniqueIdPrefix = `nodered_${account}`;
        const stateTopic = `nodered_octopus/${account}/status`;

        // Command Topics (For listening)
        const cmdTopicLimit = `nodered_octopus/${account}/set_limit`;
        const cmdTopicTime = `nodered_octopus/${account}/set_time`;
        const cmdTopicSubmit = `nodered_octopus/${account}/submit_changes`;

        // 2. Constants & Validation
        const TIME_OPTIONS = [
            "04:00", "04:30", "05:00", "05:30", 
            "06:00", "06:30", "07:00", "07:30", 
            "08:00", "08:30", "09:00", "09:30", 
            "10:00", "10:30", "11:00"
        ];

        // 3. Sensor Definitions (Read-Only)
        const sensors = [
            // Formatted timestamps (show "1 hour ago" in Home Assistant)
            { id: "next_charge", name: "Next Charge Time", class: "timestamp", icon: "mdi:timer", val: "next_start" },
            { id: "total_energy", name: "Total Planned Energy", class: "energy", unit: "kWh", val: "total_energy" },
            { id: "next_kwh", name: "Next Slot Energy", class: "energy", unit: "kWh", val: "next_kwh" },
            { id: "source", name: "Charge Source", icon: "mdi:help-circle", val: "next_source" },
            // Individual slot times (formatted)
            { id: "slot1_start", name: "Slot 1 Start", class: "timestamp", icon: "mdi:timer-outline", val: "slot1_start" },
            { id: "slot1_end", name: "Slot 1 End", class: "timestamp", icon: "mdi:timer-outline", val: "slot1_end" },
            { id: "slot2_start", name: "Slot 2 Start", class: "timestamp", icon: "mdi:timer-outline", val: "slot2_start" },
            { id: "slot2_end", name: "Slot 2 End", class: "timestamp", icon: "mdi:timer-outline", val: "slot2_end" },
            { id: "slot3_start", name: "Slot 3 Start", class: "timestamp", icon: "mdi:timer-outline", val: "slot3_start" },
            { id: "slot3_end", name: "Slot 3 End", class: "timestamp", icon: "mdi:timer-outline", val: "slot3_end" },
            // Overall window (formatted)
            { id: "window_start", name: "Overall Window Start", class: "timestamp", icon: "mdi:timer-play", val: "window_start" },
            { id: "window_end", name: "Overall Window End", class: "timestamp", icon: "mdi:timer-stop", val: "window_end" },

            // Raw timestamp strings (show exact API timestamp)
            { id: "next_charge_raw", name: "Next Charge Time (Raw)", icon: "mdi:timer", val: "next_start_raw" },
            { id: "slot1_start_raw", name: "Slot 1 Start (Raw)", icon: "mdi:timer-outline", val: "slot1_start_raw" },
            { id: "slot1_end_raw", name: "Slot 1 End (Raw)", icon: "mdi:timer-outline", val: "slot1_end_raw" },
            { id: "slot2_start_raw", name: "Slot 2 Start (Raw)", icon: "mdi:timer-outline", val: "slot2_start_raw" },
            { id: "slot2_end_raw", name: "Slot 2 End (Raw)", icon: "mdi:timer-outline", val: "slot2_end_raw" },
            { id: "slot3_start_raw", name: "Slot 3 Start (Raw)", icon: "mdi:timer-outline", val: "slot3_start_raw" },
            { id: "slot3_end_raw", name: "Slot 3 End (Raw)", icon: "mdi:timer-outline", val: "slot3_end_raw" },
            { id: "window_start_raw", name: "Overall Window Start (Raw)", icon: "mdi:timer-play", val: "window_start_raw" },
            { id: "window_end_raw", name: "Overall Window End (Raw)", icon: "mdi:timer-stop", val: "window_end_raw" }
        ];

        // 4. Helper: Announce Controls (Write-Enabled)
        function announceControls() {
            if (!enableMqtt || !node.broker) return;

            // Single device definition with branding
            const device = {
                identifiers: [`nodered_octopus_${account}`],
                name: "Octopus Intelligent",
                manufacturer: "Octopus Energy",
                model: "Intelligent Octopus Go",
                sw_version: "1.0.0",
                suggested_area: "Energy",
                configuration_url: "https://octopus.energy/intelligent/"
            };

            // A. The Slider (Number) - now shows pending value
            const limitConfig = {
                name: "Octopus Target Charge",
                unique_id: `${uniqueIdPrefix}_target_limit`,
                state_topic: stateTopic,
                command_topic: cmdTopicLimit,
                value_template: "{{ value_json.pending_limit }}",
                min: 50, max: 100, step: 5,
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

            // D. Add sensors for confirmed values (read-only display)
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

            // E. Announce Read-Only Sensors
            sensors.forEach(sensor => {
                const payload = {
                    name: `Octopus ${sensor.name}`,
                    unique_id: `${uniqueIdPrefix}_${sensor.id}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.${sensor.val} }}`,
                    device: device
                };
                if (sensor.class) payload.device_class = sensor.class;
                if (sensor.unit) payload.unit_of_measurement = sensor.unit;
                if (sensor.icon) payload.icon = sensor.icon;
                node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_${sensor.id}/config`, JSON.stringify(payload), { retain: true });
            });

            // Subscribe to Commands
            node.broker.client.subscribe(cmdTopicLimit);
            node.broker.client.subscribe(cmdTopicTime);
            node.broker.client.subscribe(cmdTopicSubmit);
        }

        // 5. Helper: Set Preferences (The Mutation)
        let retryTimeouts = []; // Track pending retry timeouts
        let expectedLimit = null;
        let expectedTime = null;

        // Pending vs Confirmed state
        let pendingLimit = 80;
        let pendingTime = "08:00";
        let confirmedLimit = 80;
        let confirmedTime = "08:00";

        async function setPreferences(newLimit, newTime) {
            // Validation
            let limit = parseInt(newLimit);
            let time = newTime;

            // Enforce Limits
            if (isNaN(limit) || limit < 50) limit = 50;
            if (limit > 100) limit = 100;
            // Round to nearest 5
            limit = Math.round(limit / 5) * 5;

            // Validate Time
            if (!TIME_OPTIONS.includes(time)) {
                node.warn(`Invalid time '${time}' requested. Defaulting to 08:00`);
                time = "08:00";
            }

            // Cancel any pending retry attempts from previous changes
            retryTimeouts.forEach(timeout => clearTimeout(timeout));
            retryTimeouts = [];

            try {
                node.status({ fill: "blue", shape: "dot", text: "Updating Settings..." });

                // A. Get Token
                const authResponse = await axios.post("https://api.octopus.energy/v1/graphql/", {
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
                const mutation = `
                mutation setPreferences($input: VehicleChargingPreferencesInput!) {
                    setVehicleChargePreferences(input: $input) { __typename }
                }`;

                const variables = {
                    input: {
                        accountNumber: account,
                        weekdayTargetSoc: limit,
                        weekendTargetSoc: limit,
                        weekdayTargetTime: time,
                        weekendTargetTime: time
                    }
                };

                const mutationResponse = await axios.post("https://api.octopus.energy/v1/graphql/", {
                    query: mutation,
                    variables: variables
                }, { headers: { Authorization: token } });

                if (mutationResponse.data.errors) {
                    throw new Error(`Mutation failed: ${JSON.stringify(mutationResponse.data.errors)}`);
                }

                // C. Start exponential backoff validation
                expectedLimit = limit;
                expectedTime = time;
                node.status({ fill: "blue", shape: "ring", text: "Verifying changes..." });

                // Schedule retries with exponential backoff: 15s, 30s, 60s, 120s
                const retryIntervals = [15000, 30000, 60000, 120000];
                scheduleRetries(retryIntervals, 0);

            } catch (err) {
                node.error("Failed to set preferences: " + err.message);
                if (err.response) {
                    node.error(`Response: ${JSON.stringify(err.response.data)}`);
                }
                node.status({ fill: "red", shape: "ring", text: "Update Failed" });
                expectedLimit = null;
                expectedTime = null;
            }
        }

        function scheduleRetries(intervals, index) {
            if (index >= intervals.length) {
                // All retries exhausted, let normal interval take over
                node.status({ fill: "yellow", shape: "dot", text: "Waiting for normal sync..." });
                expectedLimit = null;
                expectedTime = null;
                return;
            }

            const timeout = setTimeout(async () => {
                await fetchDataWithValidation(intervals, index);
            }, intervals[index]);

            retryTimeouts.push(timeout);
        }

        async function fetchDataWithValidation(intervals, currentIndex) {
            try {
                const result = await fetchData(true); // Pass flag to indicate validation mode

                // Check if the data matches our expected values
                if (result && result.validated) {
                    // Success! Changes confirmed
                    node.status({ fill: "green", shape: "dot", text: `Confirmed: ${result.confirmedLimit}% @ ${result.confirmedTime}` });
                    expectedLimit = null;
                    expectedTime = null;
                    // Clear remaining timeouts
                    retryTimeouts.forEach(timeout => clearTimeout(timeout));
                    retryTimeouts = [];
                } else {
                    // Not yet updated, schedule next retry
                    const attempt = currentIndex + 1;
                    const totalAttempts = intervals.length;
                    node.status({ fill: "blue", shape: "ring", text: `Retry ${attempt}/${totalAttempts}...` });
                    scheduleRetries(intervals, currentIndex + 1);
                }
            } catch (error) {
                // Error during fetch, schedule next retry
                node.warn(`Retry ${currentIndex + 1} failed: ${error.message}`);
                scheduleRetries(intervals, currentIndex + 1);
            }
        }

        // 6. Logic: Fetch Data (Read)
        async function fetchData(validationMode = false) {
            // Debug object to track API calls
            const debugInfo = {
                timestamp: new Date().toISOString(),
                step: null,
                success: false,
                error: null,
                apiCalls: [],
                validationMode: validationMode
            };

            if (!apiKey || !account) {
                debugInfo.error = "Missing configuration: apiKey or account number not provided";
                debugInfo.step = "validation";
                node.status({ fill: "red", shape: "ring", text: "Config Missing" });
                node.send({
                    payload: buildDefaultPayload(),
                    debug: debugInfo
                });
                return { validated: false };
            }

            try {
                // STEP 1: Get Token
                debugInfo.step = "authentication";
                node.status({ fill: "yellow", shape: "ring", text: "Authenticating..." });

                const authRequest = {
                    url: "https://api.octopus.energy/v1/graphql/",
                    query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                    variables: { input: { APIKey: apiKey } }
                };

                const authResponse = await axios.post(authRequest.url, {
                    query: authRequest.query,
                    variables: authRequest.variables
                });

                debugInfo.apiCalls.push({
                    step: 1,
                    name: "authentication",
                    url: authRequest.url,
                    statusCode: authResponse.status,
                    hasErrors: !!(authResponse.data.errors),
                    errors: authResponse.data.errors || null
                });

                // Validate auth response
                if (authResponse.data.errors) {
                    throw new Error(`Auth failed: ${JSON.stringify(authResponse.data.errors)}`);
                }
                if (!authResponse.data.data || !authResponse.data.data.obtainKrakenToken) {
                    throw new Error(`Auth response missing token data. Response: ${JSON.stringify(authResponse.data)}`);
                }

                const token = authResponse.data.data.obtainKrakenToken.token;
                debugInfo.apiCalls[0].tokenObtained = !!token;
                debugInfo.apiCalls[0].tokenPrefix = token ? token.substring(0, 20) + "..." : null;

                // STEP 2: Fetch Data
                debugInfo.step = "fetching_data";
                node.status({ fill: "yellow", shape: "ring", text: "Fetching data..." });

                const masterQuery = `
                query getData($account: String!) {
                    plannedDispatches(accountNumber: $account) { startDt endDt deltaKwh meta { source } }
                    vehicleChargingPreferences(accountNumber: $account) { weekdayTargetSoc weekdayTargetTime }
                }`;

                const dataResponse = await axios.post("https://api.octopus.energy/v1/graphql/", {
                    query: masterQuery,
                    variables: { account: account }
                }, { headers: { Authorization: token } });

                debugInfo.apiCalls.push({
                    step: 2,
                    name: "data_query",
                    url: "https://api.octopus.energy/v1/graphql/",
                    accountNumber: account,
                    authHeaderFormat: "Raw token (no Bearer/JWT prefix)",
                    statusCode: dataResponse.status,
                    hasErrors: !!(dataResponse.data.errors),
                    errors: dataResponse.data.errors || null,
                    hasData: !!(dataResponse.data.data)
                });

                // Validate data response
                if (dataResponse.data.errors) {
                    throw new Error(`Data query failed: ${JSON.stringify(dataResponse.data.errors)}`);
                }
                if (!dataResponse.data.data) {
                    throw new Error(`Data response missing data field. Response: ${JSON.stringify(dataResponse.data)}`);
                }

                // STEP 3: Extract and Process
                debugInfo.step = "processing";
                const data = dataResponse.data.data || {};
                const slots = data.plannedDispatches || [];
                const prefs = data.vehicleChargingPreferences || {};

                debugInfo.apiCalls[1].slotsFound = slots.length;
                debugInfo.apiCalls[1].preferencesFound = !!(prefs.weekdayTargetSoc);
                debugInfo.apiCalls[1].slotDetails = slots.map(s => ({
                    start: s.startDt,
                    end: s.endDt,
                    kwh: s.deltaKwh,
                    source: s.meta?.source
                }));

                // Update Confirmed State (from API)
                confirmedLimit = prefs.weekdayTargetSoc || confirmedLimit;
                confirmedTime = prefs.weekdayTargetTime || confirmedTime;

                // On successful fetch, sync pending to confirmed if not in validation mode
                if (!validationMode) {
                    pendingLimit = confirmedLimit;
                    pendingTime = confirmedTime;
                }

                // Process slots
                const now = new Date();
                // Include active slots (endDt in future) and future slots
                const activeAndFutureSlots = slots.filter(s => new Date(s.endDt) > now);
                const nextSlot = activeAndFutureSlots[0] || null;

                // Total energy for all active/future slots
                const totalEnergy = activeAndFutureSlots.reduce((sum, s) => sum + (s.deltaKwh || 0), 0);

                debugInfo.apiCalls[1].activeAndFutureSlots = activeAndFutureSlots.length;
                debugInfo.processingTime = now.toISOString();

                // Build Payload
                const statusPayload = {
                    next_start: nextSlot ? nextSlot.startDt : null,
                    total_energy: parseFloat(totalEnergy.toFixed(2)),
                    next_kwh: nextSlot ? nextSlot.deltaKwh.toFixed(2) : "0",
                    next_source: nextSlot && nextSlot.meta ? nextSlot.meta.source : "unknown",
                    // Confirmed values (from API)
                    confirmed_limit: confirmedLimit,
                    confirmed_time: confirmedTime,
                    // Pending values (user's current selections)
                    pending_limit: pendingLimit,
                    pending_time: pendingTime,
                    // Individual slots (first 3 active/future) - formatted timestamps
                    slot1_start: activeAndFutureSlots[0] ? activeAndFutureSlots[0].startDt : null,
                    slot1_end: activeAndFutureSlots[0] ? activeAndFutureSlots[0].endDt : null,
                    slot2_start: activeAndFutureSlots[1] ? activeAndFutureSlots[1].startDt : null,
                    slot2_end: activeAndFutureSlots[1] ? activeAndFutureSlots[1].endDt : null,
                    slot3_start: activeAndFutureSlots[2] ? activeAndFutureSlots[2].startDt : null,
                    slot3_end: activeAndFutureSlots[2] ? activeAndFutureSlots[2].endDt : null,
                    // Overall window (first start to last end) - formatted timestamps
                    window_start: activeAndFutureSlots.length > 0 ? activeAndFutureSlots[0].startDt : null,
                    window_end: activeAndFutureSlots.length > 0 ? activeAndFutureSlots[activeAndFutureSlots.length - 1].endDt : null,
                    // Raw timestamp strings (exact API output)
                    next_start_raw: nextSlot ? nextSlot.startDt : null,
                    slot1_start_raw: activeAndFutureSlots[0] ? activeAndFutureSlots[0].startDt : null,
                    slot1_end_raw: activeAndFutureSlots[0] ? activeAndFutureSlots[0].endDt : null,
                    slot2_start_raw: activeAndFutureSlots[1] ? activeAndFutureSlots[1].startDt : null,
                    slot2_end_raw: activeAndFutureSlots[1] ? activeAndFutureSlots[1].endDt : null,
                    slot3_start_raw: activeAndFutureSlots[2] ? activeAndFutureSlots[2].startDt : null,
                    slot3_end_raw: activeAndFutureSlots[2] ? activeAndFutureSlots[2].endDt : null,
                    window_start_raw: activeAndFutureSlots.length > 0 ? activeAndFutureSlots[0].startDt : null,
                    window_end_raw: activeAndFutureSlots.length > 0 ? activeAndFutureSlots[activeAndFutureSlots.length - 1].endDt : null
                };

                // Success!
                debugInfo.success = true;
                debugInfo.step = "complete";

                // Check if we're validating a preference change
                let isValidated = false;
                if (validationMode && expectedLimit !== null && expectedTime !== null) {
                    // Check if the returned values match what we set
                    isValidated = (confirmedLimit === expectedLimit && confirmedTime === expectedTime);
                    debugInfo.expectedLimit = expectedLimit;
                    debugInfo.expectedTime = expectedTime;
                    debugInfo.receivedLimit = confirmedLimit;
                    debugInfo.receivedTime = confirmedTime;
                    debugInfo.validated = isValidated;
                }

                // ALWAYS publish data to prevent sensors becoming unavailable
                node.send({
                    payload: statusPayload,
                    debug: debugInfo
                });

                if (enableMqtt && node.broker) {
                    node.broker.client.publish(stateTopic, JSON.stringify(statusPayload), { retain: true });
                }

                // Update status (validation mode will override this in fetchDataWithValidation)
                if (!validationMode) {
                    node.status({ fill: "green", shape: "dot", text: `Confirmed: ${confirmedLimit}% @ ${confirmedTime}` });
                }

                // Return validation result
                return { validated: isValidated || !validationMode, confirmedLimit, confirmedTime };

            } catch (error) {
                debugInfo.success = false;
                debugInfo.error = {
                    message: error.message,
                    stack: error.stack,
                    response: error.response ? {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    } : null
                };

                // Log to Node-RED (only if not in validation mode to avoid spam)
                if (!validationMode) {
                    node.error(`Octopus API Error at ${debugInfo.step}: ${error.message}`);
                    if (error.response) {
                        node.error(`Response: ${JSON.stringify(error.response.data)}`);
                    }

                    // Update status
                    node.status({
                        fill: "red",
                        shape: "ring",
                        text: `Error: ${debugInfo.step}`
                    });

                    // Send default payload with debug info
                    node.send({
                        payload: buildDefaultPayload(),
                        debug: debugInfo
                    });
                }

                // Return failure for validation
                return { validated: false };
            }
        }

        // Helper: Build default payload when errors occur
        function buildDefaultPayload() {
            return {
                next_start: null,
                total_energy: 0,
                next_kwh: "0",
                next_source: "unknown",
                confirmed_limit: confirmedLimit,
                confirmed_time: confirmedTime,
                pending_limit: pendingLimit,
                pending_time: pendingTime,
                slot1_start: null,
                slot1_end: null,
                slot2_start: null,
                slot2_end: null,
                slot3_start: null,
                slot3_end: null,
                window_start: null,
                window_end: null,
                // Raw timestamp strings
                next_start_raw: null,
                slot1_start_raw: null,
                slot1_end_raw: null,
                slot2_start_raw: null,
                slot2_end_raw: null,
                slot3_start_raw: null,
                slot3_end_raw: null,
                window_start_raw: null,
                window_end_raw: null
            };
        }

        // 7. Event Listeners
        
        // Helper: Publish current state (both pending and confirmed)
        function publishCurrentState() {
            if (enableMqtt && node.broker) {
                const quickState = {
                    pending_limit: pendingLimit,
                    pending_time: pendingTime,
                    confirmed_limit: confirmedLimit,
                    confirmed_time: confirmedTime
                };
                node.broker.client.publish(stateTopic, JSON.stringify(quickState), { retain: false });
            }
        }

        // A. Handle Node-RED Input Messages
        node.on('input', function (msg) {
            // Check for control commands
            if (msg.payload && typeof msg.payload === 'object') {
                if (msg.payload.set_limit || msg.payload.set_time) {
                    // Use new values if present, otherwise keep existing
                    const targetLimit = msg.payload.set_limit || confirmedLimit;
                    const targetTime = msg.payload.set_time || confirmedTime;
                    setPreferences(targetLimit, targetTime);
                    return; // Don't run standard fetch if setting
                }
            }
            // If just a trigger, run fetch
            fetchData();
        });

        // B. Handle MQTT Commands (Home Assistant)
        if (enableMqtt && node.broker) {
            node.broker.register(this);

            // Slider changed - update pending value only
            node.broker.subscribe(cmdTopicLimit, 0, (topic, payload) => {
                const val = parseInt(payload.toString());
                pendingLimit = val;
                publishCurrentState(); // Update display immediately
                node.status({ fill: "yellow", shape: "dot", text: `Pending: ${pendingLimit}% @ ${pendingTime}` });
            });

            // Dropdown changed - update pending value only
            node.broker.subscribe(cmdTopicTime, 0, (topic, payload) => {
                const val = payload.toString();
                pendingTime = val;
                publishCurrentState(); // Update display immediately
                node.status({ fill: "yellow", shape: "dot", text: `Pending: ${pendingLimit}% @ ${pendingTime}` });
            });

            // Button pressed - submit changes to API
            node.broker.subscribe(cmdTopicSubmit, 0, (topic, payload) => {
                setPreferences(pendingLimit, pendingTime);
            });
            
            setTimeout(announceControls, 2000);
        }

        // Init
        const intervalId = setInterval(fetchData, refreshRate);
        setTimeout(fetchData, 1000);
        node.on('close', () => {
            clearInterval(intervalId);
            // Clear any pending retry timeouts
            retryTimeouts.forEach(timeout => clearTimeout(timeout));
            retryTimeouts = [];
            if (node.broker) node.broker.unsubscribe(cmdTopicLimit, cmdTopicTime, cmdTopicSubmit);
        });
    }

    RED.nodes.registerType("octopus-intelligent", OctopusIntelligentNode, {
        credentials: { apiKey: { type: "password" } }
    });
};