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
            // Note: We removed the "Confirmed" sensors because the Controls below now act as the display
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

                await axios.post("https://api.octopus.energy/v1/graphql/", {
                    query: mutation,
                    variables: variables
                }, { headers: { Authorization: `Bearer ${token}` } });

                // C. Trigger Immediate Refresh
                node.status({ fill: "green", shape: "dot", text: "Success! Refreshing..." });
                setTimeout(fetchData, 2000); // Wait 2s for API to update then read back

            } catch (err) {
                node.error("Failed to set preferences: " + err.message);
                node.status({ fill: "red", shape: "ring", text: "Update Failed" });
            }
        }

        // 6. Logic: Fetch Data (Read)
        // Note: We need to store current state globally so we can update just one field at a time
        let currentLimit = 80;
        let currentTime = "08:00";

        async function fetchData() {
            if (!apiKey || !account) return;
            try {
                // ... (Auth Logic same as before) ...
                const authResponse = await axios.post("https://api.octopus.energy/v1/graphql/", {
                    query: `mutation obtainToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }`,
                    variables: { input: { APIKey: apiKey } }
                });
                const token = authResponse.data.data.obtainKrakenToken.token;

                // Master Query
                const masterQuery = `
                query getData($account: String!) {
                    plannedDispatches(accountNumber: $account) { startDt endDt deltaKwh meta { source } }
                    vehicleChargingPreferences(accountNumber: $account) { weekdayTargetSoc weekdayTargetTime }
                }`;

                const dataResponse = await axios.post("https://api.octopus.energy/v1/graphql/", {
                    query: masterQuery,
                    variables: { account: account }
                }, { headers: { Authorization: `Bearer ${token}` } });

                // Extract
                const data = dataResponse.data.data || {};
                const slots = data.plannedDispatches || [];
                const prefs = data.vehicleChargingPreferences || {};
                
                // Update Local State
                currentLimit = prefs.weekdayTargetSoc || currentLimit;
                currentTime = prefs.weekdayTargetTime || currentTime;

                // Build Payload
                const statusPayload = {
                    // ... (Slot logic same as before) ...
                    confirmed_limit: currentLimit,
                    confirmed_time: currentTime
                };
                
                // Publish
                node.send({ payload: statusPayload });
                if (enableMqtt && node.broker) {
                    node.broker.client.publish(stateTopic, JSON.stringify(statusPayload), { retain: true });
                }
                node.status({ fill: "green", shape: "dot", text: `Limit: ${currentLimit}% | Time: ${currentTime}` });

            } catch (error) {
                node.error(error);
            }
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