# hearth-ctx-card

A one-slot contextual card for wall-mounted Home Assistant dashboards. Shows exactly one thing — the most important thing right now — and renders nothing when there's nothing worth saying.

Priority stack (first match wins):

1. **Weather alert** — NWS Alerts sensor ([finity69x2/nws_alerts](https://github.com/finity69x2/nws_alerts)); coral for Extreme/Severe, amber otherwise
2. **Camera** — live feed on person occupancy or doorbell press (doorbell wins)
3. **Vacuum stuck** — error / out of water / dock problem
4. **Sports** — [Team Tracker](https://github.com/vasqued2/ha-teamtracker) sensors: live game > recent final (default 60 min) > imminent kickoff (default 90 min)
5. **Laundry** — SmartThings-style machine/job/completion sensors, with "finished" linger
6. **Vacuum maintenance** — consumable end-of-life
7. **Daily saying** — text helper, `quote|attribution` format

Vanilla JS, shadow DOM, zero dependencies. Live camera uses HA's own `ha-camera-stream` (falls back to the MJPEG proxy), so it works without internet access.

## Options

```yaml
type: custom:hearth-ctx-card
accent: '#FFB27A'
alert_color: '#ff6b5e'
weather_alerts: sensor.nws_alerts
cameras:              # in priority order
  - camera: camera.porch
    motion: binary_sensor.porch_person_occupancy
    doorbell: binary_sensor.porch_visitor   # optional
    name: porch
camera_linger: 20     # s, after occupancy clears
doorbell_hold: 60     # s, after a doorbell press
vacuum:
  entity: vacuum.roborock_s7
  name: Rosie
  error: sensor.roborock_s7_vacuum_error
  dock_error: sensor.roborock_s7_dock_error
  water_shortage: binary_sensor.roborock_s7_water_shortage
  room: sensor.roborock_s7_current_room
  consumables:
    - entity: sensor.roborock_s7_filter_time_left
      name: filter
sports:               # teamtracker sensors
  - sensor.tt_world_cup
post_minutes: 60
pre_minutes: 90
laundry:
  state: sensor.washer_machine_state
  job: sensor.washer_job_state
  completion: sensor.washer_completion_time
  name: Washer
laundry_linger: 30    # min
maintenance_hours: 2  # consumable time-left threshold
saying: input_text.portal_daily_saying
demo: null            # weather|camera|camera2|stuck|sports|final|pre|laundry|maintenance|saying
```

MIT.
