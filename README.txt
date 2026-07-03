APS Truck GPS PWA - Smooth Safety Build v1.0.0
================================================

What this build includes
------------------------
- Installable iPhone/Android PWA for GitHub Pages hosting.
- Fast mobile-first layout using vanilla JavaScript, no heavy framework.
- Live GPS position button.
- Route planning with online normal-road routing when internet is available.
- Direct offline route fallback when online route service is unavailable.
- Truck profile: vehicle type, height, safety margin, width, length, weight.
- Bridge Height Safety System:
  - compares truck height + safety margin against saved bridge/underpass warnings.
  - blocks low clearances as STOP.
  - warns on tight clearance.
  - warns when truck route data is not certified/complete.
- Add your own low bridge or restriction points by latitude/longitude.
- Saved depots/places.
- Saved routes.
- Offline Maps & Truck Routes screen with current route, state, and All Australia pack buttons.
- Backup/export/import JSON.
- Core app files cached for offline opening after first load.

Important safety note
---------------------
This first build is a route-assistance foundation. It is NOT a certified truck GPS and NOT a replacement for:
- bridge height signs,
- NHVR/state road authority maps,
- permits,
- official road closures/restrictions,
- professional truck-routing datasets.

Low bridge accuracy depends on the data loaded into the app. This build intentionally warns that truck-route data is not certified so it does not create false safety confidence.

How to host on GitHub Pages
---------------------------
1. Create a new GitHub repository, for example: aps-truck-gps
2. Upload all files from this folder:
   - index.html
   - styles.css
   - app.js
   - manifest.json
   - sw.js
   - assets folder
3. Go to repository Settings > Pages.
4. Set Source to Deploy from branch, branch main, folder /root.
5. Open the GitHub Pages link on iPhone Safari.
6. Tap Share > Add to Home Screen.

Custom domain idea
------------------
Use a subdomain such as:
truckgps.apsprofencing.com.au

Namecheap DNS example:
Type: CNAME
Host: truckgps
Value: YOUR-GITHUB-USERNAME.github.io

Recommended next upgrades
-------------------------
1. Add official/paid truck routing API such as HERE Truck Routing or another commercial truck-routing provider.
2. Import official bridge height and heavy vehicle network datasets from state/NHVR sources where licensing allows.
3. Add state-by-state offline data packages stored outside GitHub Pages if data size becomes large.
4. Convert to Capacitor/native iPhone app if full-Australia offline route packs are required.
5. Add voice guidance and rerouting only after truck-safe route data is reliable.

Files
-----
index.html    Main app shell
styles.css    Mobile UI styling
app.js        App logic and safety engine
sw.js         Service worker cache
manifest.json PWA manifest
assets/       App icons
