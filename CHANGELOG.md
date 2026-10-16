# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] — 2026-10-16

### Added
- **SmartFlex vehicle data.** If Octopus controls your car or charge point, `msg.payload` now includes its details every 30 minutes. It turns on by itself when the node finds the device.
  - `vehicle_make`, `vehicle_model`, `vehicle_battery_kwh`, `charger_power_kw`
  - `device_state`: what Octopus says the device is doing, for example `SMART_CONTROL_IN_PROGRESS`, `BOOSTING` or `LOST_CONNECTION`. The charging poll reads it, so it updates every refresh interval and always agrees with `boosting`.
  - `device_alerts`: Octopus alert messages, as `[{ message, published_at }]`. Only the 10 newest are kept, newest first, and each message is cut to 250 characters.
  - `charging_sessions`: your last 5 charging sessions, newest first, with `start`, `end`, `kwh_added`, `soc_change`, `soc_final`, `type`, `cost`, and `problems`. `last_session` is the latest finished one. `kwh_added` is in kWh, even if Octopus sends watt-hours.
  - `last_session_kwh`, `last_session_soc_final`, `last_session_problem`: the latest finished session as single values.
  - `smartflex_vehicle_error`: the last error as a short `KT-CT-xxxx: message`, or `null`. If Octopus returns only part of the data (for example the sessions fail), the node keeps what came back and the last values for the rest, and logs a warning.
- **SmartFlex inverter data (experimental, off by default).** Not yet verified on a real inverter. Tick **Inverter** in the node settings to read it every 5 minutes. It only runs if Octopus lists a SmartFlex inverter on your account. Fields: `inverter_make`, `inverter_model`, `solar_peak_kw`, `inverter_power_kw`, `inverter_connection_status`, `inverter_online`, `home_battery_power_kw`, `home_battery_soc`, `solar_power_kw`, `grid_power_kw`, `site_consumption_kw`, `site_export_kw` and `smartflex_inverter_error`.
- Home Assistant (MQTT), on the same Octopus Intelligent device. The vehicle entities are only published when Octopus lists a SmartFlex car or charge point on the account, and the inverter entities only when the Inverter option is ticked and Octopus lists an inverter. Otherwise they are removed, but only when Octopus lists devices and none is of that kind. If Octopus lists no devices at all, which can happen for a moment, they are left as they are. If you go back to an older version, these entities stay in Home Assistant and show Unavailable, not a problem. The broker still holds their retained discovery config, so Home Assistant will not delete them one by one. To remove them, clear their retained discovery topics on the broker, or delete the Octopus Intelligent device in Home Assistant (you then lose the names and areas you set).
  - Each of these entities checks that its field is in the state message. A missing field reads Unavailable. Number sensors show unknown when the value is empty. The text sensors (Vehicle Make, Vehicle Model, Vehicle Device State, Inverter Make, Inverter Model and Inverter Connection Status) show Unavailable when the value is empty, not the word "None".
  - Last Charge Session Energy (the session list and alerts are its attributes), Last Charge Session Final Charge and a Last Charge Session Problem binary sensor. Last Charge Session Energy has state class `total`, reset at the end of each session. Home Assistant keeps its statistics, and you can add it to the Energy dashboard. Last Charge Session Final Charge is a percentage with no battery device class, so low-battery alerts do not pick it up.
  - Diagnostic sensors: Vehicle Make, Vehicle Model, Vehicle Battery Size, Charger Power, Vehicle Device State, SmartFlex Vehicle Error and its error binary sensor.
  - Octopus lists a charge point as an electric vehicle. So a charge point gets the Boost Charge switch and the charging poll, like a car. Vehicle Make and Vehicle Model then show the charger's make and model.
  - With the Inverter option ticked and an inverter listed: Solar Power, Home Battery Power, Home Battery Charge, Grid Power, Site Consumption, Site Export and Inverter Power. Diagnostic entities: Inverter Make, Inverter Model, Solar Peak Power, Inverter Connection Status, an Inverter Online binary sensor, SmartFlex Inverter Error and its error binary sensor. Unticking the option removes them.
- **Boost Charge.** New `set_boost` input (`true` starts a boost, `false` cancels it), a Boost Charge switch in Home Assistant (only when Octopus lists a car or charger it controls), and `boosting` and `boost_error` payload fields. A boost charges now, outside the Octopus plan. It is not the same as `set_smart_charging`. `charging_now` is now `true` during a boost too.
  - Octopus can refuse a boost, for example when the car is unplugged. The node then logs the Octopus error, sends `boost_error` straight away and does not retry. That message has `msg.debug.trigger` set to `boost_failed`, with `request` (`BOOST` or `CANCEL`) and `error`, so a flow can tell it from a poll. A boost that works clears `boost_error`, and so does the first charging poll that reads the device state a minute or more later.
  - If Octopus refuses the same choice 3 times in 10 minutes, the node ignores that choice for the next 10 minutes and logs one warning. This stops a flow that asks again after each refusal from calling Octopus all day. A request Octopus accepts ends the pause.
  - Only `true` and `false` work. Any other `set_boost` value gives a node error and sends nothing. On MQTT, a payload other than `ON` or `OFF` logs a warning.
  - The node sends one boost request at a time, at least 5 seconds apart, and only your last choice. A repeat of a choice Octopus has just accepted is dropped. After a failure, the same choice is sent again once the 5 seconds have passed. If Octopus does not answer a boost request within 75 seconds, the node gives up on it, sets `boost_error` and polls Octopus to check. Later requests are then sent as normal.
  - When Octopus accepts a boost or a cancel, the node polls Octopus soon after. That poll waits if 3 planned-dispatch queries have already gone out in the last minute. After a refusal it does not poll, because nothing changed. If the answer is not clear, for example an error on the part Octopus reads back, the node leaves the switch as it was, sets no `boost_error` and polls to check.
  - Octopus can take a moment to show the new state, so the switch shows what you asked for until Octopus agrees, for up to 2 minutes.
  - `boosting` goes back to `null` if no charging poll has confirmed it for twice the refresh interval, for example during an Octopus outage. `charging_now` then follows the plan again, and the Boost Charge switch shows unknown.

### Changed
- The Octopus Intelligent device in Home Assistant now shows the node's version as its software version. Before, it always showed 2.0.0. No entity changes.
- If Octopus lists more than one car or charger, the node now uses the one Octopus says is live. Before, it used the first in the list, which could be an old car you have replaced. If none is live, it still uses the first. Smart charging, boost, the charging poll and the vehicle entities all use this one device.
- Error text in the Node-RED log, the node status and `msg.payload` now shows what Octopus sent, including an API key it echoes back, so a wrong key can be seen and fixed. API keys and tokens are still hidden in what the node publishes to Home Assistant, which keeps it in its history.
- Retained MQTT messages on `submit_changes`, `refresh`, `set_smart_charging`, `set_charge_cap`, and `set_boost` are now ignored, with one warning per topic. The broker replays a retained message on every restart, so a retained command used to run again each time. Home Assistant does not retain these commands, so its buttons and switches work as before.

### Documentation
- The example dashboards show the Boost Charge switch. The Home Assistant example adds SmartFlex vehicle and last session cards, and the Dashboard 2.0 example adds a Vehicle panel with recent charging sessions.
- The `set-preferences.json` example flow has Boost now and Cancel boost Inject nodes.
- Four new example flows. Each one links to your existing node and has a Read me note.
  - `examples/boost-on-cheap-or-surplus.json`: starts a boost when the import rate is low or you export spare power, and cancels it when that ends.
  - `examples/charging-and-error-alerts.json`: sends an alert when charging or a boost starts or stops, when an `*_error` field changes, and when Octopus posts a device alert.
  - `examples/cheapest-window-planner.json`: finds the cheapest run of half hours for an appliance before a deadline, and sends a message when it starts.
  - `examples/daily-charging-summary.json`: sends a morning summary of the last day's charging sessions, and a message when a session ends.
- The Dashboard 2.0 Category Errors panel now uses the real `*_error` field names. Before, it looked for `electricity_tariff_error` and `gas_tariff_error`, so it never showed rates errors. It also left out the dispatch errors. It now lists the dispatch, SmartFlex and boost errors too.
- The node help now says which errors get the quick charging poll retry (`KT-CT-4340` and `KT-CT-4339`). Other errors wait for the next normal poll.

## [1.6.2] — not released on its own; included in 1.7.0

These fixes were prepared as 1.6.2 (and 1.6.3) and ship in 1.7.0. If you are upgrading from 1.6.1, read this section as well as 1.7.0.

### Upgrading from 1.6.1
- The `*_error` fields now hold short text, not the raw error JSON from Octopus. A Kraken error reads `CODE: message`, for example `KT-CT-1111: Unauthorized`, or just the message when there is no code. An outage page or rate limit reads `HTTP 503` or `HTTP 429`. `intelligent_error` no longer starts with `Devices query failed` or `Dispatches query failed` when Octopus sends a code. If a flow runs `JSON.parse` on an `*_error` value, or looks for `"errorCode"` in it, change it to read the code at the start of the text. Home Assistant error sensors only check whether the field is empty, so they work as before.
- The node now sends an extra output message when a saving session, free electricity session or rate slot starts or ends (`msg.debug.trigger` is `active_fields_change`). This also happens on accounts without a car or charger. If a flow treats any message with `msg.debug` as a change to `charging_now`, check `msg.debug.trigger === 'charging_state_change'` instead.

### Changed
- **Faster recovery when Octopus can't return the charging plan.** When the charging poll fails with `KT-CT-4340` (planned dispatches) or `KT-CT-4339` (charging preferences), the node tries the charging poll again after 30 seconds, 1 minute, and 2 minutes, then every 2 minutes, until it works or the next normal poll is due. A retry waits if 3 planned-dispatch queries have already gone out in the last minute, counting normal polls and the check 30 seconds before a slot. The known plan and charging timers stay in place while it retries.
- The Node-RED log now shows a warning for each failed charging poll or retry, for example `Charging poll failed: KT-CT-4340 Unable to fetch planned dispatches (retry 2 in 60s)`, and one line when it works again, for example `Charging poll recovered after 4m 30s`.
- `msg.payload.intelligent_error` and the node status now show a short error with the Octopus code, for example `KT-CT-4340: Unable to fetch planned dispatches`, instead of the raw error JSON. It is always under 255 characters. The node status still starts with `Error: `, as in 1.6.1, for example `Error: KT-CT-4340: Unable to fetch planned dispatches`.
- Every other `*_error` field now shows a short error too, for example `KT-CT-1111: Unauthorized`, or just the message when Octopus sends no code. Timeouts and auth failures are also cut to under 255 characters. Before, a long error could be rejected by Home Assistant, which does not accept a state over 255 characters.

### Fixed
- If Octopus can't return the charging preferences (`KT-CT-4339`), the node keeps the last confirmed target and ready-by time and still updates the charging slots. Before, the whole charging poll failed.
- Home Assistant commands could run twice after a partial redeploy. The node now removes its MQTT command subscriptions and releases the MQTT broker when it is closed.
- **Polling could stop for good after one request with no answer.** Requests to Octopus had no time limit, so a request that never answered blocked every later poll until Node-RED restarted, with no log line. Every request now gives up if Octopus sends nothing for 30 seconds. If a poll is still running after 10 minutes, the next poll starts anyway and the Node-RED log shows a warning. The old poll stops after its current request. Anything the old poll had already read is read again by the new one.
- The npm update check also gives up after 30 seconds with no answer.
- A poll that finished after the node was closed or redeployed could still restart charging timers. It now stops instead.
- Redeploying the node in the first second after it started could leave an extra poll loop running. Stopping the node now cancels it.
- A reply from Octopus that stopped part way, or arrived very slowly, could hold up every poll for 10 minutes. A request now fails as soon as the connection closes early, and gives up after 30 seconds in total.
- An outage page or rate limit from Octopus now shows as `HTTP 503` or `HTTP 429` in the log and the `_error` fields. Before, it showed a parse error or `Response missing data`.
- After you changed the target, the ready-by time or Charge Cap, a poll that was already running could put the old values back in Home Assistant until the next charging poll. The new values now stay.
- Redeploying the node during a poll no longer lets the old node send the rest of that poll's requests to Octopus.
- Pressing Submit twice quickly, or while a change was still being checked, no longer runs two sets of checks. Only the latest change is checked.
- If a change to the target, ready-by time or Charge Cap got no answer from Octopus, for example after a time-out, the node reported it as failed, even if Octopus had made it. The node now shows the change as unconfirmed and polls straight away to read the real values. If that poll shows the change was not made, the status turns red (`Update Failed` or `Charge Cap update failed`) and the log shows a warning. Only a time-out, a connection that closed after the change was sent, or an HTTP 5xx error counts as no answer. A change that could not reach Octopus, for example after a DNS or connection error, or that got an HTTP 4xx error or a reply the node could not read, still fails straight away with an error, as in 1.6.1. The Smart Charging switch now follows the same rule: a change with no answer is checked with Octopus after 15 seconds, 30 seconds, 1 minute and 2 minutes, instead of being reported as failed.
- An Octopus API key or login token is now hidden in what the node publishes to Home Assistant. Octopus can repeat part of a request in an error message, so a key could have been shown there. A login token that follows a dotted word is hidden in full. (1.7.0 shows the key in the Node-RED log, the node status and `msg.payload`, so a wrong key can be seen and fixed. See 1.7.0 Changed.)
- If the node could not log in to Octopus for a poll, sensors that update hourly stayed empty or out of date for up to an hour, and the update check failed for a day. The update check now runs anyway, as it does not use Octopus. The other polls try again after 1 minute, then 2, 4 and 8 minutes, and then every 10 minutes until the login works. If Octopus says how long to wait (a rate limit with `Retry-After`), the node waits at least that long, up to 10 minutes.
- If the system clock was set back, for example after starting with a clock that was ahead, polls stopped until the clock caught up again, and charging poll retries were held back. Polls now carry on straight away. A small correction of under a minute, for example from NTP, does not make every poll run again.
- If Octopus briefly returned no devices when the node started, charging polls stayed off until the node was restarted. The node now checks again after 30 seconds, 1 minute, 2 minutes and then every 5 minutes, up to 6 times. When it finds the car or charger, charging polls start.
- During an Octopus outage where requests got no answer, one round of polls could take up to 10 minutes, and refreshes and retries had to wait. After the first request that times out, loses its connection or gets an HTTP 5xx error, the node now leaves the other polls for the next round.
- After a new target was confirmed, a charging poll that had started before the change could put the old target back, for example "Confirmed: 90%" instead of 50%, until the next charging poll. The same could happen to the ready-by time and Charge Cap. Such a poll now keeps only its charging slots, and the node reads the settings again straight away. This also covers a change confirmed after the charging poll but before the rest of that round of polls had finished, and a target or ready-by time picked in Home Assistant but not applied yet, which used to jump back at the end of that round.
- A node that kept failing its start-up check with Octopus, for example with a wrong account number, used a little more memory every 5 minutes until it was restarted. It no longer does.
- A very large reply from Octopus or the npm registry, such as an error page sent over and over, is now cut off at 2 MB and the request fails. Before, the node kept all of it in memory until the 30 second time limit.
- If Octopus or the npm registry sent a reply that was not the expected JSON object, for example `null`, the `_error` fields showed a code error such as `Cannot read properties of null`. They now show `Unexpected response shape`.
- If the node could not read the car or charger when it started, the Smart Charging and Charge Cap switches and target changes failed with `Device ID not available` until a charging poll worked. The node now uses the device found by its start-up check.
- If the node could not log in to Octopus during normal polling, the Node-RED log showed nothing. It now shows one warning when the login starts failing and one line when it works again.
- On an account with no car or charger, the node status stayed green while polls failed. It now shows the first error, in red when every Octopus poll failed and in yellow when only some did. Accounts with a car or charger show the charging status as before.
- A number field could show `NaN` or `Infinity` in `msg.payload`, and `unknown` in Home Assistant, when Octopus sent a value that was not a number. Rates, standing charges, consumption, the account balance, Home Mini readings, the rate summary, dispatch energy and Wheel of Fortune spins now show no value (`null`) instead. A daily consumption reading that Octopus has not filled in yet is skipped, so consumption no longer shows `NaN`.
- `set_timezone` accepted any text, from a flow or from Home Assistant. A wrong name was saved, and every display time then showed the raw UTC text. The node now checks the name and writes an error to the Node-RED log if it does not know it, or if it is over 64 characters. The timezone is then not changed.
- A very long text value from Octopus, such as a tariff code or a time it could not read, could stop a Home Assistant sensor updating, because Home Assistant does not accept a state over 255 characters. Such text is now cut to 254 characters.
- A bad `set_limit` or `set_time` value is now shown cut to 40 characters in the error and the node status. A very long value used to fill the log. A value a flow cannot turn into text, such as a Symbol, now gives the usual error instead of a code error.
- If Octopus could not return the smart charging state (for example `KT-CT-4360`) when the node started, the start-up check failed and nothing was polled at all, not even rates or consumption, until it worked. The check now asks again without the smart charging state, finds the car or charger, and starts polling. The log shows one warning.
- A failed poll of rates, consumption, the account and the other data, or a failed update check, showed only in its `_error` field. The Node-RED log now shows one warning when a poll starts failing, for example `account poll failed: HTTP 502`, and one line when it works again.
- A very long error from Octopus could fill the Node-RED log with one line of about 8,000 characters, and the end of the line, such as `Retrying in 30s.`, was lost. Error text in a log line is now cut to 300 characters, and a log line to 500, keeping its end.

### Fixed (prepared as 1.6.3)
- The Electricity Export Rate Error sensors were always empty, because export rate errors were only saved in `applicable_rates_export_error`. They are now saved in `electricity_export_rate_error` too, so the sensors show them.
- The Octoplus poll no longer asks Octopus for `isOctoplusEnrolled`, which Octopus has marked for removal. If Octopus removed it, the whole Octoplus poll would fail. `octoplus_enrolled` now comes from the enrolment status.
- A refresh, a plan-change re-poll, or the check after a change you sent could be skipped if it was asked for while that data was already being polled. It then waited for the next normal poll, up to the refresh interval. It now runs straight after the current poll.
- The node now publishes `charging_now` on the first poll after it starts. Before, a restart that spanned the end of a charging slot could leave Home Assistant showing Charging Now as on until the next slot.
- The node no longer creates timers or sends messages after it is closed or redeployed, even when a request to Octopus answers late.
- The check 30 seconds before a slot now handles an Octopus error such as `KT-CT-4340`. It logs a warning and starts the slot on time from the known plan. Before, it did nothing and the slot started up to 10 seconds late. If that check is still waiting for Octopus when the slot starts, the slot now starts on time anyway. Before, a slow answer could start it a few seconds late.
- `msg.payload.charging_now` and the JSON state topic now match the Charging Now sensor on every message. Before, messages from other polls (such as Home Mini) could carry the old value until the next charging poll.
- The Smart Charging switch now follows changes made in the Octopus app. The charging poll reads the smart charging state and updates the switch when it changes. After a slow start, the switch no longer stays unknown. If Octopus can't return the smart charging state, for example with `KT-CT-4360`, the switch keeps its last state and the rest of the charging poll still works. The log shows one warning until the state is back.
- The node no longer makes a second, untracked MQTT subscription to each command topic.
- Saving session, free electricity, and current rate sensors now change at the start and end time. Before, they could be wrong until the next poll of that data, up to an hour. The node sends an extra output message when these change (`msg.debug.trigger` is `active_fields_change`), so on a half-hourly tariff there is one more message every 30 minutes.
- `next_kwh` no longer shows `NaN` when Octopus sends an energy value that is not a number. It shows `0`, as `total_energy` already did.

### Documentation
- Removed `msg.debug` from the poll output docs. Poll messages carry only `msg.payload`. The extra message sent when `charging_now` changes still carries `msg.debug`.
- Documented refresh from a flow and the checks on command values, including the `set_timezone` check.
- Corrected the polling description. Intervals, run order, clock alignment, and which groups poll are now accurate.
- Corrected timezone notes. Persistence needs a persistent context store, and daily consumption uses the editor Timezone field.
- Listed the rate band, rate summary, previous and next rate, saving session, and update entities. Marked the always-empty Wheel of Fortune and error sensors.
- Fixed the property names and the Inject nodes in the example flows, and in the node help.
- Replaced the stale field count, the old changelog copy, and the "covers every entity" wording for the dashboard.

## [1.6.1] — 2026-10-03

First public 1.6 release. 1.6.0 was only distributed as a preview build; everything in it is included here.

### Added
- **Charge Cap** — new Home Assistant switch, `set_charge_cap` input and `charge_cap` payload field (limit smart charging to off-peak rates only, as in the Octopus app).
- One input message can now carry several commands; each is applied independently.

**Dashboard 2.0 example flow**
- `examples/node-red-dashboard-flow.json` — complete importable Dashboard 2.0 flow with 34 widgets across 6 pages (Controls, Status, Tariff, Optimization, Account, Diagnostics).
- Two annotated **sample function nodes** embedded in the flow (`find-cheapest-window`, `is-cheapest-now`) demonstrating user-side derivation patterns over the `applicable_rates` array. Marked as user-modifiable example code, not part of the node's published payload — keeping with the "expose raw data, no inference" principle.
- Writable controls (target limit slider, ready-by dropdown, smart-charging switch, Charge Cap switch, refresh button, timezone override) routed back into the node input.

### Changed
- Ready-by time accepts any half-hour slot from 00:00 to 23:30, matching the Octopus app (was 04:00–11:00).
- Target charge accepts 5–100%, matching the Octopus app (was 50–100). Values still round to the nearest 5. The Home Assistant slider and the Dashboard 2.0 example go down to 5%.
- Invalid values are now rejected with an error and nothing is sent to Octopus, including `set_limit: 0` and empty strings. Previously an invalid time was silently replaced with 08:00 and sent. Partly numeric limits such as `"8O"` or `"85%"` are rejected rather than truncated. `null` values are ignored as before.
- Dashboard 2.0 example flow and HA dashboard example updated for 1.6: the ready-by dropdown offers all 48 half-hour times, and both include the Charge Cap switch.

### Fixed
- Ready-by times after 11:00 were rejected (#3).
- Target charge values below 50% were silently raised to 50% (#3).
- **Day/Night and EV Peak/Off-Peak rate sensors stuck at "unavailable"** —
  `electricity_day_rate`, `electricity_night_rate`, `electricity_ev_peak_rate`,
  `electricity_ev_off_peak_rate` were published with `entity_category: config`, which
  is invalid for read-only sensors (same issue fixed for tariff codes in v1.3.0; missed
  on these four when added in v1.5.0). On some HA Core versions this now causes outright
  entity-registration failure rather than just a stuck state. Removed the category — no
  entity ID changes, not a breaking change. On upgrade these four sensors move from the
  Configuration section to the Sensors section of the Home Assistant device page. Sensor definitions also extracted to
  `lib/sensor-definitions.js` with regression coverage asserting no read-only sensor
  carries `entity_category: config`.
- **Node stopped polling after a transient Octopus error at startup** — if Octopus's API returned a
  temporary error while the node was starting (seen live as `KT-CT-4360` on device status), the node
  gave up on product discovery and never started polling; a manual refresh then stayed on
  "Manual refresh..." until Node-RED restarted. Discovery now retries (30 s, 1 min, 2 min, then every
  5 min) and shows "Discovery failed — retrying in …" while it does, and a failure on the device
  status field alone no longer blocks discovery.
- **Slot sensors could show an out-of-date charging plan** — the check made 30 s before each slot
  picks up a re-planned schedule and `charging_now` follows it, but the slot and window sensors kept
  the old plan until the next scheduled poll. The node now polls immediately when that check finds
  the plan has changed.
- **One failing field could stop all charging updates** — if Octopus returned an error for the Charge Cap
  setting alone, the whole charging poll failed and slot sensors stopped updating. Charge Cap is now read
  separately, so slots, limit and ready-by time keep updating and the switch keeps its last known state.

### Backwards compatibility
- No MQTT topic, `unique_id` or entity ID changes from npm 1.5.0 or the 1.6.0 preview. New since 1.5.0: the Charge Cap switch, its `set_charge_cap` command topic, and 48 options on the Ready Time select. Pinned by `__tests__/discovery-snapshot.test.js`.

## [1.5.0] — 2026-06-13

Schedule visibility, tariff rate bands, and proactive update notification.

### Added — Schedule visibility (import & export)
- 24h schedule stats: `applicable_rates_{min,max,median,avg}_pence` and `electricity_export_rate_*` equivalents. Min/max/median/avg of the next 24h's half-hourly rate schedule.
- The full `applicable_rates` / `electricity_export_rate` slot arrays now exposed as MQTT entity attributes on the existing `*_count` sensors, accessible via `state_attr(...)` in HA templates.

### Added — Tariff rate bands
- `electricity_day_rate`, `electricity_night_rate`, `electricity_ev_peak_rate`, `electricity_ev_off_peak_rate` — raw tariff-defined rate bands from the Kraken `DayNightTariff` / `FourRateEvTariff` types. Null on tariffs that don't expose banding (e.g. `HalfHourlyTariff` users see nulls; Economy 7 / FourRateEv users see populated values).

### Added — Update notification
- HA MQTT Update entity (`update.octopus_intelligent_node_update`) surfacing newer-version availability in Home Assistant's Settings → Updates panel. Requires HA ≥ 2022.4.
- Node-RED debug log emits `node.warn` once per detected new version, with install instructions.
- New payload fields: `installed_version`, `latest_version`, `update_available`, `update_check_at`, `update_check_error`. Check runs once per 24h via the unified scheduler.

### Added — Promotion to MQTT entities (closing v1.3.0 gaps)
- 8 previously payload-only fields promoted to MQTT entities: `applicable_rates_prev_pence/_gbp/_to`, `applicable_rates_next_pence/_gbp/_from`, `electricity_export_rate_prev_gbp`, `electricity_export_rate_next_gbp`.

### Added — Per-category error binary sensors
- 15 new binary_sensors with `device_class: problem`, one per category. `OFF` when healthy / `ON` when the corresponding `<category>_error` payload field is set. Existing string error sensors retained — no breakage for users referencing them in automations.

### Fixed
- Example dashboard: Home Mini live demand gauge now goes down to `-10 kW` (was `min: 0`), correctly displaying solar-export demand.

### Backwards compatibility
- All existing payload field names, MQTT topics, HA entity unique_ids, input commands, and node config fields are preserved. v1.4.0 → v1.5.0 is a zero-config upgrade.

## [1.4.0] — 2026-05-29

Single poll loop. The V1 `setInterval(fetchData)` intelligent loop and the V2 `createScheduler(pollDueCategories)` category loop are merged into one clock-aligned scheduler with one auth and one emit per tick. No HA-side changes.

### Fixed
- **Intermittent `KT-CT-1199` "Too many requests"** on `flexPlannedDispatches` — the standalone `flex_planned_dispatches` V2 category queried the same endpoint as the V1 intelligent poll, and the two unsynchronised loops phase-drifted into bursts that tripped Kraken's burst limit. The intelligent poll now owns `flexPlannedDispatches`; the standalone category is removed.
- **Whole payload was nuked on any single-category error**, and `intelligent_error` was never set. Every category now follows one error policy: record `<category>_error`, keep last-good data, retry next interval. No permanent disable.
- **Slow polls could overlap a tick** — added an in-flight guard around the scheduler.

### Changed (internal architecture; no HA-side breakage)
- Every category exposes `async poll(token) → partialPayload`. Simple categories use a `simplePoll` factory; the intelligent poll is a bespoke category that owns both the devices and dispatch queries.
- Tick / poll / error-merge logic moved into `lib/poll-tick.js` and `lib/scheduler.js` for unit-test coverage.
- Manual refresh, MQTT refresh, and post-mutation validation re-polls all go through the same scheduler / intelligent-poll path.

### Unchanged
- All payload field names, MQTT topics, `unique_id`s, HA entity IDs, input commands, and node config fields.

## [1.3.3] — 2026-05-22

### Fixed
- **Saving Sessions card showed a 2-year-old session as "next"** — the category was emitting `events[0]` with no filter/sort, so stale historical events surfaced in `saving_session_start/end` and `saving_session_available` was effectively true forever. Now matches the `free-electricity` pattern: filter out ended events, sort earliest-first, take the first. `saving_session_available` now means "an upcoming session exists" as originally intended.
- **Octoplus "Enrolled" and "Loyalty points user" stuck at "unavailable"** — both binary sensors were published with `entity_category: config`, which makes read-only sensor state stick at "unavailable" on some HA installs. Removed — same fix as the v1.3.0 tariff-sensor cleanup. Entity IDs are unchanged; not a breaking change.
- **Example dashboard — Wheel of Fortune cards showed "Entity not found"** — `examples/ha-dashboard.yaml` referenced `..._wheel_of_fortune_*_spins`, but the entities are named "WoF …" so HA generates `..._wof_*_spins`. Corrected.
- **Example dashboard — Home Mini gauge showed "Entity is non-numeric"** on accounts with no Home Mini — the gauge is now wrapped in a conditional card that hides until the entity reports a value.

### Added
- `saving_session_window_active` (binary sensor) — true when an upcoming session window is currently happening, regardless of whether you joined.
- `saving_session_active` (binary sensor) — true only when you have joined the current session AND we are inside its window. Use this to drive automations that should only run when there is a payoff.

### Changed (HA-side breaking)
- `saving_session_joined` now publishes as `binary_sensor` instead of `sensor` — fixes the "False" display anomaly caused by HA's sensor domain rejecting raw booleans. **Update automations and dashboards referencing `sensor.saving_session_joined` to use `binary_sensor.saving_session_joined`.** Payload field name (`msg.payload.saving_session_joined`) is unchanged. Mirror of the v1.3.0 `octoplus_enrolled` migration. The plugin publishes an empty config to the old `sensor/.../config` topic on startup to clean the orphan from HA.

## [1.3.2] — 2026-05-14

Defensive hardening pass following the v1.3.1 hotfix audit. No user-facing behaviour change against the current live Kraken API — every affected field already arrives as a JSON number today. The fix forecloses the same latent crash class (`TypeError: ...toFixed is not a function`) if Kraken ever serialises these scalars as strings, matching how `energyAddedKwh` is already returned.

### Fixed
- `lib/categories/electricity.js` — `tariff.unitRate` and `tariff.standingCharge` (both import and export branches) now coerce via `parseFloat()` before emitting. Prevents string passthrough that would (a) break `device_class: monetary` sensors in HA and (b) crash any downstream arithmetic.
- `lib/categories/gas.js` — same treatment for `tariff.unitRate` and `tariff.standingCharge`.
- `lib/categories/account.js` — `balance` (pence) now coerces via `parseFloat()` before emitting `account_balance_pence`. JavaScript's `/` operator was already coercing for `account_balance_pounds`, so this only tightens type consistency on the integer pence field.

### Tests
- Added string-input regression tests for each coerced field, asserting `typeof === 'number'`. 4 new tests, 237 total (was 233).

## [1.3.1] — 2026-05-14

Critical hotfix for v1.3.0. Users on 1.3.0 should upgrade immediately.

### Fixed
- **Intelligent category crash on numeric string inputs** — `flexPlannedDispatches.energyAddedKwh` is returned by the live Kraken API as a string. The intelligent category's reduce accumulator concatenated strings instead of summing, then called `.toFixed()` on the resulting string, raising `TypeError: totalEnergy.toFixed is not a function`. Whole intelligent payload section fell back to `defaultData` (null slot times, `total_energy: 0`, `next_kwh: "0"`), which surfaced in Home Assistant as "Error updating entity" for every intelligent sensor. Fixed by coercing `energyAddedKwh` via `parseFloat()` before arithmetic and formatting in `lib/categories/intelligent.js`, matching the pattern already used in `lib/categories/flex-planned-dispatches.js`. Added regression tests covering both positive and negative (export dispatch) string inputs.
- `next_kwh` now consistently formats with two decimal places (e.g. `"5.50"`, `"15.20"`) per the documented contract in README, HTML help, and `test-mocks.js`. The v1.3.0 path stripped trailing zeros via `String(parseFloat(...))` — that branch is unreachable now because it always crashed before reaching it, but the format is corrected for completeness.

## [1.3.0] — 2026-05-12

Major additive release covering the full Octopus Energy consumer read surface. No breaking changes to v1.2.x payload fields, entity IDs, MQTT topics, input commands, or node config fields. All v1.2.x automations and dashboards continue to work unchanged.

### Added — Electricity (import)
- `electricity_standing_charge` — daily standing charge (p/day)
- `electricity_unit_rate` — fixed unit rate (p/kWh); `null` on half-hourly tariffs
- `electricity_tariff_code`, `electricity_valid_from`, `electricity_valid_to`
- `electricity_consumption_kwh` — previous day import consumption
- `electricity_consumption_from`, `electricity_consumption_to` — period boundaries
- `applicable_rates`, `applicable_rates_count` — full 48-slot half-hourly schedule
- `applicable_rates_current_pence`, `applicable_rates_current_gbp` — live rate (use these on half-hourly tariffs)
- `applicable_rates_prev_pence/_gbp/_to`, `applicable_rates_next_pence/_gbp/_from` — adjacent slot rates and transition timestamps (payload-only; not currently exposed as MQTT entities — see README)

### Added — Electricity (export)
- `electricity_export_standing_charge` — typically `0` for Agile Outgoing
- `electricity_export_unit_rate` — fixed; `null` on half-hourly export tariffs
- `electricity_export_tariff_code` (e.g. `AGILE-OUTGOING-19-05-13`), `electricity_export_valid_from`, `electricity_export_valid_to`
- `electricity_export_consumption_kwh`, `_from`, `_to` — previous day export from the export meter
- `electricity_export_rate`, `electricity_export_rate_count` — full 48-slot half-hourly export schedule
- `electricity_export_rate_current_pence/_gbp` — live export rate
- `electricity_export_rate_prev_pence/_to`, `electricity_export_rate_next_pence/_from` — adjacent export slot rates

### Added — Gas
- `gas_standing_charge`, `gas_unit_rate`, `gas_tariff_code`, `gas_valid_from`, `gas_valid_to`
- `gas_consumption_kwh`, `gas_consumption_from`, `gas_consumption_to`

### Added — Home Mini
- `mini_demand_kw` (kW, numeric) — real-time grid demand
- `mini_consumption_delta_kwh` (kWh, numeric) — half-hour period consumption
- `mini_read_at` — timestamp of most recent telemetry
- Opt-in via "Enable Home Mini" checkbox in node config

### Added — Rewards
- `saving_session_available` (binary), `saving_session_start`, `saving_session_end`, `saving_session_joined`
- `free_electricity_active` (binary), `free_electricity_available` (binary), `free_electricity_start`, `free_electricity_end`
- `wheel_of_fortune_electricity_spins`, `wheel_of_fortune_gas_spins` — opt-in via node config checkbox
- `octoplus_enrolled` (binary sensor), `octoplus_enrollment_status` (string), `octoplus_loyalty_points_user` (binary sensor)

### Added — Account & dispatches
- `account_balance_pounds`, `account_balance_pence`
- `completed_dispatches` (array), `completed_dispatches_count` — completed intelligent dispatch history
- `flex_planned_dispatches` (array), `flex_planned_dispatches_count` — upcoming flex dispatches (replaces deprecated `plannedDispatches`)

### Added — Infrastructure
- **Account discovery** — automatic product detection at startup; categories auto-enable based on registered products and discover both import and export meter points by `direction`, not array position
- **Per-category poll intervals** — configurable in node editor for each data source
- **1-second clock-aligned category scheduler** — independent polling; one slow category doesn't block others

### Changed
- **Octopus `wheelOfFortuneSpins` migrated to `wheelOfFortuneSpinsAllowed`** on `api.backend.octopus.energy` — the old field was deprecated and scheduled for removal 2026-04-20
- **Octopus `savingSessions` migrated to `api.backend.octopus.energy`** endpoint — the field was removed from the main endpoint
- **`octoplus_enrolled` and `octoplus_loyalty_points_user` now publish as `binary_sensor` instead of `sensor`** — these are boolean values and HA's sensor domain rejects raw booleans. **HA-side breaking change for users referencing the old `sensor.*` entity IDs**: update automations and dashboards to use `binary_sensor.*`. Payload field names (`msg.payload.octoplus_enrolled`, `msg.payload.octoplus_loyalty_points_user`) are unchanged.
- **`entity_category: config` removed** from read-only tariff/validity sensors (`electricity_unit_rate`, `electricity_tariff_code`, `electricity_valid_from/to`, `gas_*`, `electricity_export_*`, `saving_session_start/end`, `free_electricity_start/end`, `octoplus_enrollment_status`). These now appear in the main device entity list rather than a separate Configuration section. HA's `entity_category: config` is intended for user-configurable entities (switches, numbers, selects) — applying it to read-only sensors caused state to stick at "unavailable" on some installs.

### Fixed
- **Import/export meter point selection** — discovery now selects meter points by the `direction` field (`IMPORT` or `EXPORT`), not array position. Earlier dev builds on accounts with both meters could surface export data as import (live "current rate" showing the export Agile rate instead of the import tariff). No stable v1.x release was affected; caught and fixed before v1.3.0 ship.
- **MQTT transport headers** — `lib/graphql.js` now sends `User-Agent: node-red-contrib-octopus-intelligent/<version>` on every request. Without it, `api.backend.octopus.energy` returns 403 at the edge — which previously surfaced as "WoF returns HTML" and silently broken saving sessions.
- **MQTT auth format** — uses raw JWT in the Authorization header (no `JWT ` prefix). Main endpoint accepts both; backend endpoint sub-resolvers require the raw form.
- **Saving sessions schema migration** — removed deprecated `octopoints` field from `SavingSessionsAccountType` query (Octopus moved loyalty points to the Octoplus query).
- **Gas tariff query fragments** — `GasTariffType` is an object type, not a union — removed inline fragments that caused "Fragment cannot be spread here" errors.

### Unchanged (no breaking changes)
- All v1.2.x payload field names in `msg.payload`
- All v1.2.x MQTT topics, `unique_id` values, and HA entity IDs (except the Octoplus domain change noted above)
- All v1.2.x input commands: `set_limit`, `set_time`, `set_smart_charging`, `set_timezone`
- All v1.2.x node config fields: `accountNumber`, `apiKey`, `broker`, `enableMqtt`, `name`, `refreshInterval`, `timezoneOverride`
- Intelligent Octopus Go charging schedule, smart charging toggle, charging preferences

---

## [1.2.1] — 2026-04-29

### Fixed
- **Deprecated API migration** — moved smart-charging verification from the deprecated `registeredKrakenflexDevice` query to the current `devices` query
- **Mutation migration** — `setVehicleChargePreferences` (deprecated) replaced with `setDevicePreferences` using the 7-day schedule input
- **Startup device fetch** — uses the current `devices` query instead of deprecated `registeredKrakenflexDevice`

### Unchanged
- All v1.2.0 payload fields, MQTT topics, and entity IDs preserved

---

## [1.2.0] - 2026-04-26

### Added
- **Smart Charging Toggle** — suspend or unsuspend Octopus intelligent charging from Node-RED or Home Assistant
  - `msg.payload = { set_smart_charging: true }` — enable (unsuspend)
  - `msg.payload = { set_smart_charging: false }` — disable (suspend)
- **HA MQTT Switch** — "Smart Charging" switch entity in Home Assistant (auto-discovered)
- **`smart_charging` payload field** — `true` = active, `false` = suspended, `null` = unknown (startup fetch pending or failed)
- **Device ID startup fetch** — `krakenflexDeviceId` fetched once at startup via `registeredKrakenflexDevice` query; cached permanently

### Technical
- Mirrors `setPreferences` pattern: auth → mutation → optimistic update → exponential backoff verification (15s/30s/60s/120s)
- Verification re-fetches `registeredKrakenflexDevice.suspended` to confirm state change
- Zero new npm dependencies

---

## [1.1.1] - 2026-04-26

### Security
- **Removed `axios` dependency** — replaced with Node.js built-in `https` module; eliminates 13 transitive packages and all associated supply chain risk
- **Removed test/mock files from npm package** — `__tests__/` and `test-mocks.js` no longer published; removes 139 kB of dev artefacts from end-user installs
- **Removed images from npm package** — 364 kB of images no longer bundled; README images now reference GitHub raw URLs and render correctly on npmjs.com

### Changed
- Package size reduced from 369 kB → 27 kB (93% reduction)
- Zero production dependencies (was: `axios ^1.6.0`)

---

## [1.1.0] - 2026-04-24

### Added
- **Locale Timestamps** — new `*_locale` fields in every payload, always in server auto-detected timezone
  - `slot1_start_locale`, `slot1_end_locale`, `slot2_start_locale`, `slot2_end_locale`
  - `slot3_start_locale`, `slot3_end_locale`, `window_start_locale`, `window_end_locale`
  - `next_start_locale`
- **Timezone Metadata** — `timezone_detected` (server auto-detect) and `timezone_applied` (active TZ for display fields)
- **HA Timezone Select Entity** — `select.octopus_timezone` with 15 curated IANA timezones covering all Octopus operating countries (UK, AU, DE, ES, NZ, US)
  - Selection persists across Node-RED restarts via node context storage
  - State republished to HA on Node-RED startup
- **`set_timezone` Input Command** — `msg.payload = { set_timezone: "Europe/London" }`, same pattern as `set_limit`/`set_time`
- **`timezoneOverride` Node Config Field** — optional IANA timezone in node editor, leave blank for auto-detect
- **Timezone Diagnostic Sensors** — `sensor.octopus_timezone_detected` and `sensor.octopus_timezone_applied`

### Changed
- **Display timestamp fields now output resolved timezone** instead of raw UTC
  - Affected fields: `slot1_start`, `slot1_end`, `slot2_start`, `slot2_end`, `slot3_start`, `slot3_end`, `window_start`, `window_end`, `next_start`
  - Resolution order: HA-persisted selection → `timezoneOverride` config → server auto-detected
  - **Raw fields (`*_raw`) remain unchanged** — always exact UTC strings from the API

### Technical
- Zero new npm dependencies — native `Intl.DateTimeFormat` API (Node 14 compatible)
- `convertToTimezone(dateStr, tz)` — handles DST correctly, falls back to original string on error
- `resolveTimezone(node)` — reads node context storage, config field, or server auto-detect

## [1.0.5] - 2025-12-31

### Fixed
- **README Documentation** - Removed misleading "Octopus Energy branded device cards" claim
  - Changed to accurate description: "Clean Organization" and "Professional Layout"
  - No actual Octopus Energy branding exists in Home Assistant device cards
  - Avoids potential trademark/copyright concerns

## [1.0.4] - 2025-12-11

### Added
- **Manual Refresh Button (MQTT)** - "Octopus Refresh API" button in Home Assistant
  - Hardcoded 30-second rate limiting to prevent API spam
  - Shows warning in Node-RED when rate limited
  - Publishes refresh cooldown state to MQTT
- **Refresh Available At Sensor** - Diagnostic timestamp sensor
  - Shows ISO timestamp when manual refresh becomes available
  - Displays as countdown in Home Assistant ("in 25 seconds")
  - Automatically clears to `null` after 30 seconds
  - Leverages Home Assistant's native timestamp handling
- **Next Poll Time Sensors** - Shows when next automatic poll will occur
  - `sensor.octopus_next_poll_time` - Main sensor (timestamp class)
  - `sensor.octopus_next_poll_time_raw` - Diagnostic raw timestamp
  - Updates after each successful poll
- **API Complexity Tracking** - Monitor API usage against 50,000 hourly limit
  - `sensor.octopus_api_requests_hour` - Count of requests (last 60 min)
  - `sensor.octopus_api_complexity_hour` - Total complexity used
  - `sensor.octopus_api_complexity_usage` - Percentage of limit used
  - Estimated complexity: Regular poll (300), Mutation (250), Pre-validation (200)
  - All API complexity sensors in Diagnostics section
- **Enhanced Debug Output** - `msg.debug` now includes:
  - `responseHeaders` - Full HTTP response headers from API
  - `extensions` - GraphQL extensions field (if present)
  - `api_usage` - Comprehensive API usage metrics per request
- **Comprehensive Test Coverage** - Added 5 new tests
  - Tests for MQTT refresh button rate limiting
  - Tests for countdown expiry behavior
  - Validates countdown doesn't go negative
  - Tests timer cleanup and MQTT message structure

### Changed
- **Rate Limiting Strategy** - Different behavior for MQTT vs Node-RED
  - MQTT Button: Hardcoded 30-second cooldown (enforced)
  - Node-RED Input: No rate limiting (programmers control this)
  - Timestamp-based cooldown (not seconds counter)
- **State Output** - Node-RED now outputs state on every poll
  - Previously only output on changes
  - Now outputs full `statusPayload` every poll cycle
  - Better for automations and monitoring
- **Global Setter** - Updated `NodeRed_Global_Setter.js` with new fields:
  - `octopus_next_poll`
  - `octopus_refresh_available_at`
  - `octopus_api_requests_hour`
  - `octopus_api_complexity_hour`
  - `octopus_api_complexity_percent`

### Fixed
- **Cooldown Timer Expiry** - Properly publishes `null` at 30 seconds
  - Prevents countdown showing negative values in Home Assistant
  - Timer cleanup prevents memory leaks
  - Exactly 2 MQTT messages per refresh (start + expiry)

### Technical Details
- **API Complexity Estimation** - Since Octopus API doesn't provide actual complexity:
  - Uses estimated values based on query types
  - Tracks rolling 60-minute window
  - If actual complexity becomes available, will use it automatically
- **Timestamp-Based Cooldown** - Uses ISO timestamps instead of seconds
  - Home Assistant handles countdown display automatically
  - Zero MQTT spam during countdown
  - Clean `null` state when ready

## [1.0.3] - 2025-12-04

### Added
- **State reconciliation loop** for charging detection (every 10 seconds)
  - Automatically detects charging state based on cached slot timestamps
  - No API calls - uses local data only
  - Handles imminent/immediate slots when car is plugged in
  - Self-healing: corrects state if timers miss edge cases
- **Flow Library scorecard compliance**
  - Added `version` field to `node-red` section in package.json (>=2.0.0)
  - Added `examples/` folder with 3 demonstration flows
  - Satisfies Node-RED Flow Library requirements

### Fixed
- **Home Assistant sensors going "unknown"** when adjusting controls
  - Sensors now maintain last known values while editing pending preferences
  - Only update when fresh data arrives from API
  - Added `lastKnownState` cache and state merging in `publishCurrentState()`
- **Charging state not updating** for imminent/immediate slots
  - Fixed edge case where slots starting <30s after poll were not detected
  - Reconciliation loop catches these within 10 seconds
  - Ensures accurate "Charging Now" sensor in Home Assistant

### Changed
- Improved charging state management with redundant detection methods
- Enhanced MQTT state publishing to preserve sensor data during control updates

## [1.0.2] - 2025-11-30

### Changed
- Updated flow example description in Node-RED help panel for better clarity
- Improved explanation of default behavior: reads by default, manually refreshable, and accepts commands

## [1.0.1] - 2025-11-30

### Added
- **Node.js and Node-RED version requirements** in package.json engines field
  - Minimum Node.js: >=14.0.0
  - Minimum Node-RED: >=2.0.0
  - Addresses Flow Library scorecard requirements
- **Comprehensive example flows** in Node-RED help panel
  - Basic monitoring flow (inject every 5 min)
  - Set preferences from flow (JSON payload with set_limit/set_time)
  - Home Assistant MQTT integration example
- **Visual documentation** with screenshots
  - Node-RED flow examples showing monitoring, preferences, and preset buttons
  - MQTT integration flow example
  - Home Assistant device page with all entities
- **Visual Examples section** in Node-RED help panel with embedded GitHub-hosted images
- **Screenshots section** in README.md showing real-world usage

### Changed
- Updated README.md with Screenshots section after Features
- Updated .npmignore to exclude images/ folder (keeps npm package lightweight)
- Updated .gitignore to exclude local documentation files

### Fixed
- Flow Library scorecard now shows supported Node-RED and Node.js versions
- Flow Library scorecard "Nodes have examples" requirement now satisfied

## [1.0.0] - 2025-11-30

### Added
- Initial public release
- **Octopus Energy GraphQL API integration**
  - Authentication via API key
  - Fetch planned charging dispatches (smart-charge and bump-charge slots)
  - Query vehicle charging preferences (target SOC and ready time)
  - Update charging preferences via GraphQL mutations
- **Home Assistant MQTT auto-discovery**
  - Number entity: Target charge limit (50-100%)
  - Select entity: Ready time (04:00-11:00)
  - Button entity: Apply changes
  - Sensor entities: Confirmed settings, next charge time, total energy, slot times
  - Binary sensor: Charging now (ON/OFF)
  - Organized into Controls, Sensors, and Diagnostics categories
- **Real-time charging slot detection**
  - Detects currently active charging slots
  - Calculates next charging start time
  - Provides individual slot start/end times (up to 3 slots)
  - Calculates overall charging window
  - Shows charge source (smart-charge vs bump-charge)
- **Exponential backoff validation**
  - Smart retry mechanism when updating preferences
  - Prevents sensors from becoming "unavailable" during API updates
  - Validates changes at 15s, 30s, 60s, 120s intervals
- **Comprehensive debugging**
  - Full API call tracking in msg.debug
  - Success/failure status for each operation
  - Detailed error messages
- **Node-RED flow control**
  - Accept input messages to set preferences programmatically
  - Output payload with all charging data
  - 5-minute default refresh interval (configurable)
- **Octopus Energy branding**
  - Professional pink theme (#E8146F)
  - Device branded as "Octopus Intelligent" in Home Assistant
  - Suggested "Energy" area in Home Assistant
- **Unit test coverage**
  - Data processing tests (10 tests)
  - Timer management tests (10 tests)
  - Mock API responses for consistent testing

### Security
- API key stored securely as Node-RED credential (not exposed in flows)
- Account numbers sanitized in MQTT topics and entity IDs

### Documentation
- Comprehensive README.md with:
  - Feature list and capabilities
  - Installation instructions (npm and palette manager)
  - Configuration guide
  - Home Assistant setup instructions
  - Node-RED usage examples
  - Home Assistant automation examples
  - Troubleshooting section
  - Support options (GitHub Star, Sponsor, PayPal donate)
- MIT License
- GitHub repository with issue tracking

## Release Notes

### Version Numbering
This project follows [Semantic Versioning](https://semver.org/):
- **MAJOR** version (X.0.0): Breaking changes
- **MINOR** version (1.X.0): New features (backwards compatible)
- **PATCH** version (1.0.X): Bug fixes (backwards compatible)

### Links
- [npm Package](https://www.npmjs.com/package/node-red-contrib-octopus-intelligent)
- [GitHub Repository](https://github.com/ASomerN/node-red-contrib-octopus-intelligent)
- [Node-RED Flow Library](https://flows.nodered.org/node/node-red-contrib-octopus-intelligent)
- [Issues & Bug Reports](https://github.com/ASomerN/node-red-contrib-octopus-intelligent/issues)

### Support
- ⭐ [Star on GitHub](https://github.com/ASomerN/node-red-contrib-octopus-intelligent)
- 💖 [Become a Sponsor](https://github.com/sponsors/ASomerN)
- ☕ [Donate via PayPal](https://www.paypal.com/donate?hosted_button_id=A2B8ZFEJBE2S6)
