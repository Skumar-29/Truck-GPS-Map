APS Truck GPS Navigation PWA v2
================================

This build changes the app from a simple route planner into a more real navigation-style PWA.

New in v2:
- Live GPS watchPosition tracking
- Moving GPS marker / heading arrow
- Follow mode
- Destination search
- Online route planning using normal OSRM driving routing
- Route line on real map tiles
- Turn-by-turn direction list
- Navigation HUD with next instruction, distance, ETA and arrival time
- Start/stop navigation controls
- Voice prompts using browser speech synthesis
- Off-route detection and optional auto-reroute
- Low-bridge safety checks against saved bridge/restriction points
- Block navigation when saved low-bridge point is lower than truck height + margin
- Saved routes, places, bridge warnings and JSON backup/import
- App-shell offline cache

Important safety note:
This build is not a certified truck GPS and does not include official Australia-wide truck route / low bridge datasets.
It uses normal road routing unless connected later to licensed truck routing data, official state data, NHVR data, or another verified data source.
Always obey road signs, bridge height signs, permits, NHVR/state route maps and company requirements.

GitHub Pages upload:
Upload all files in this folder to the root of your GitHub repository:
- index.html
- app.js
- styles.css
- sw.js
- manifest.json
- assets folder

Then enable GitHub Pages from Settings > Pages > Deploy from branch > main > root.


Version 2.1 update:
- Added Settings > App update panel.
- Update / refresh latest version clears app cache and reloads newest GitHub Pages files.
- Hard reload button added.
- Saved truck profile, routes, places, bridge warnings, and backups stay in local storage.
