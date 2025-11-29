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

        // 2. Constants & Validation
        const TIME_OPTIONS = [
            "04:00", "04:30", "05:00", "05:30", 
            "06:00", "06:30", "07:00", "07:30", 
            "08:00", "08:30", "09:00", "09:30", 
            "10:00", "10:30", "11:00"
        ];

        // 3. Sensor Definitions (Read-Only)
        const sensors = [
            { id: "next_charge", name: "Next Charge Time", class: "timestamp", icon: "mdi:timer", val: "next_start" },
            { id: "total_energy", name: "Total Planned Energy", class: "energy", unit: "kWh", val: "total_energy" },
            { id: "next_kwh", name: "Next Slot Energy", class: "energy", unit: "kWh", val: "next_kwh" },
            { id: "source", name: "Charge Source", icon: "mdi:help-circle", val: "next_source" },
            // Individual slot times
            { id: "slot1_start", name: "Slot 1 Start", class: "timestamp", icon: "mdi:timer-outline", val: "slot1_start" },
            { id: "slot1_end", name: "Slot 1 End", class: "timestamp", icon: "mdi:timer-outline", val: "slot1_end" },
            { id: "slot2_start", name: "Slot 2 Start", class: "timestamp", icon: "mdi:timer-outline", val: "slot2_start" },
            { id: "slot2_end", name: "Slot 2 End", class: "timestamp", icon: "mdi:timer-outline", val: "slot2_end" },
            { id: "slot3_start", name: "Slot 3 Start", class: "timestamp", icon: "mdi:timer-outline", val: "slot3_start" },
            { id: "slot3_end", name: "Slot 3 End", class: "timestamp", icon: "mdi:timer-outline", val: "slot3_end" },
            // Overall window
            { id: "window_start", name: "Overall Window Start", class: "timestamp", icon: "mdi:timer-play", val: "window_start" },
            { id: "window_end", name: "Overall Window End", class: "timestamp", icon: "mdi:timer-stop", val: "window_end" }
        ];

        // 4. Helper: Announce Controls (Write-Enabled)
        function announceControls() {
            if (!enableMqtt || !node.broker) return;

            // A. The Slider (Number)
            const limitConfig = {
                name: "Octopus Target Charge",
                unique_id: `${uniqueIdPrefix}_target_limit`,
                state_topic: stateTopic,
                command_topic: cmdTopicLimit,
                value_template: "{{ value_json.confirmed_limit }}",
                min: 50, max: 100, step: 5,
                unit_of_measurement: "%",
                icon: "mdi:battery-charging-high",
                device: { identifiers: [`nodered_octopus_${account}`], name: "Node-RED Octopus Intelligent", manufacturer: "Octopus Energy" }
            };
            node.broker.client.publish(`${mqttPrefix}/number/${uniqueIdPrefix}_limit/config`, JSON.stringify(limitConfig), { retain: true });

            // B. The Dropdown (Select)
            const timeConfig = {
                name: "Octopus Ready Time",
                unique_id: `${uniqueIdPrefix}_target_time`,
                state_topic: stateTopic,
                command_topic: cmdTopicTime,
                value_template: "{{ value_json.confirmed_time }}",
                options: TIME_OPTIONS,
                icon: "mdi:clock-time-four-outline",
                device: { identifiers: [`nodered_octopus_${account}`] }
            };
            node.broker.client.publish(`${mqttPrefix}/select/${uniqueIdPrefix}_time/config`, JSON.stringify(timeConfig), { retain: true });

            // C. Announce Read-Only Sensors (Same as before)
            sensors.forEach(sensor => {
                const payload = {
                    name: `Octopus ${sensor.name}`,
                    unique_id: `${uniqueIdPrefix}_${sensor.id}`,
                    state_topic: stateTopic,
                    value_template: `{{ value_json.${sensor.val} }}`,
                    device: { identifiers: [`nodered_octopus_${account}`] }
                };
                if (sensor.class) payload.device_class = sensor.class;
                if (sensor.unit) payload.unit_of_measurement = sensor.unit;
                if (sensor.icon) payload.icon = sensor.icon;
                node.broker.client.publish(`${mqttPrefix}/sensor/${uniqueIdPrefix}_${sensor.id}/config`, JSON.stringify(payload), { retain: true });
            });
            
            // Subscribe to Commands
            node.broker.client.subscribe(cmdTopicLimit);
            node.broker.client.subscribe(cmdTopicTime);
        }

        // 5. Helper: Set Preferences (The Mutation)
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

                // C. Trigger Immediate Refresh
                node.status({ fill: "green", shape: "dot", text: "Success! Refreshing..." });
                setTimeout(fetchData, 2000); // Wait 2s for API to update then read back

            } catch (err) {
                node.error("Failed to set preferences: " + err.message);
                if (err.response) {
                    node.error(`Response: ${JSON.stringify(err.response.data)}`);
                }
                node.status({ fill: "red", shape: "ring", text: "Update Failed" });
            }
        }

        // 6. Logic: Fetch Data (Read)
        // Note: We need to store current state globally so we can update just one field at a time
        let currentLimit = 80;
        let currentTime = "08:00";

        async function fetchData() {
            // Debug object to track API calls
            const debugInfo = {
                timestamp: new Date().toISOString(),
                step: null,
                success: false,
                error: null,
                apiCalls: []
            };

            if (!apiKey || !account) {
                debugInfo.error = "Missing configuration: apiKey or account number not provided";
                debugInfo.step = "validation";
                node.status({ fill: "red", shape: "ring", text: "Config Missing" });
                node.send({
                    payload: buildDefaultPayload(),
                    debug: debugInfo
                });
                return;
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

                // Update Local State
                currentLimit = prefs.weekdayTargetSoc || currentLimit;
                currentTime = prefs.weekdayTargetTime || currentTime;

                // Process slots
                const now = new Date();
                const futureSlots = slots.filter(s => new Date(s.startDt) > now);
                const nextSlot = futureSlots[0] || null;

                const totalEnergy = slots.reduce((sum, s) => sum + (s.deltaKwh || 0), 0);

                // Build Payload
                const statusPayload = {
                    next_start: nextSlot ? nextSlot.startDt : null,
                    total_energy: parseFloat(totalEnergy.toFixed(2)),
                    next_kwh: nextSlot ? nextSlot.deltaKwh.toFixed(2) : "0",
                    next_source: nextSlot && nextSlot.meta ? nextSlot.meta.source : "unknown",
                    confirmed_limit: currentLimit,
                    confirmed_time: currentTime,
                    // Individual slots (first 3)
                    slot1_start: futureSlots[0] ? futureSlots[0].startDt : null,
                    slot1_end: futureSlots[0] ? futureSlots[0].endDt : null,
                    slot2_start: futureSlots[1] ? futureSlots[1].startDt : null,
                    slot2_end: futureSlots[1] ? futureSlots[1].endDt : null,
                    slot3_start: futureSlots[2] ? futureSlots[2].startDt : null,
                    slot3_end: futureSlots[2] ? futureSlots[2].endDt : null,
                    // Overall window (first start to last end)
                    window_start: futureSlots.length > 0 ? futureSlots[0].startDt : null,
                    window_end: futureSlots.length > 0 ? futureSlots[futureSlots.length - 1].endDt : null
                };

                // Success!
                debugInfo.success = true;
                debugInfo.step = "complete";

                // Publish
                node.send({
                    payload: statusPayload,
                    debug: debugInfo
                });

                if (enableMqtt && node.broker) {
                    node.broker.client.publish(stateTopic, JSON.stringify(statusPayload), { retain: true });
                }
                node.status({ fill: "green", shape: "dot", text: `Limit: ${currentLimit}% | Time: ${currentTime}` });

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

                // Log to Node-RED
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
        }

        // Helper: Build default payload when errors occur
        function buildDefaultPayload() {
            return {
                next_start: null,
                total_energy: 0,
                next_kwh: "0",
                next_source: "unknown",
                confirmed_limit: currentLimit,
                confirmed_time: currentTime,
                slot1_start: null,
                slot1_end: null,
                slot2_start: null,
                slot2_end: null,
                slot3_start: null,
                slot3_end: null,
                window_start: null,
                window_end: null
            };
        }

        // 7. Event Listeners
        
        // A. Handle Node-RED Input Messages
        node.on('input', function (msg) {
            // Check for control commands
            if (msg.payload && typeof msg.payload === 'object') {
                if (msg.payload.set_limit || msg.payload.set_time) {
                    // Use new values if present, otherwise keep existing
                    const targetLimit = msg.payload.set_limit || currentLimit;
                    const targetTime = msg.payload.set_time || currentTime;
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
            node.broker.subscribe(cmdTopicLimit, 0, (topic, payload) => {
                const val = parseInt(payload.toString());
                setPreferences(val, currentTime); // Use NEW limit, OLD time
            });
            node.broker.subscribe(cmdTopicTime, 0, (topic, payload) => {
                const val = payload.toString();
                setPreferences(currentLimit, val); // Use OLD limit, NEW time
            });
            
            setTimeout(announceControls, 2000);
        }

        // Init
        const intervalId = setInterval(fetchData, refreshRate);
        setTimeout(fetchData, 1000);
        node.on('close', () => {
            clearInterval(intervalId);
            if (node.broker) node.broker.unsubscribe(cmdTopicLimit, cmdTopicTime);
        });
    }

    RED.nodes.registerType("octopus-intelligent", OctopusIntelligentNode, {
        credentials: { apiKey: { type: "password" } }
    });
};