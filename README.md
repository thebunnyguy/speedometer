# GPS Speedometer

A speedometer for iPhone that runs in Safari. No App Store, no account, and nothing leaves your phone.

**Open it:** https://thebunnyguy.github.io/speedometer/

## Use it

1. Open the link in Safari, tap **Start**, and allow location.
2. Optional: tap **Share → Add to Home Screen**. It then opens full-screen with its own icon, and launches even without a data connection.
3. Tap the unit under the speed to switch between km/h, mph and knots.
4. Tap the speed-limit sign to set an alert. Above the limit the digits and arc turn red and it beeps.
5. Tap **HUD** for a mirrored display: lay the phone flat on the dashboard, top edge toward you, and read the reflection in the windshield.
6. **Reset trip** needs two taps, so a bump can't wipe your trip.

The screen stays on while the app is open. If your iPhone doesn't allow that, set Auto-Lock to Never while driving.

## How the speed is measured

- Speed comes from the GPS chip's Doppler measurement (`coords.speed`), which is measured from the satellite signals themselves rather than from changes in position. Under open sky it is typically within about 1 km/h.
- If the chip reports no speed, the app falls back to distance travelled over the last few seconds, and ignores movement smaller than the GPS jitter so a parked phone reads 0. The screen labels this "Position speed, less precise".
- A small Kalman filter weighs each reading by its uncertainty. A single wild reading is held back until the next one confirms it.
- Trip distance integrates speed over time. Signal gaps such as tunnels are bridged with the straight-line distance between good fixes. Max speed must hold for two good fixes in a row.

On a simulated drive with noisy fixes, a glitch spike, a 30-second tunnel and two stops, the engine read cruise speed within 0.6 km/h (RMS), rejected the spike, kept max speed within 0.5 km/h, measured distance within 0.1 %, and showed exactly 0 while parked.

## Privacy

Location is processed on the phone only. The page has no analytics and sends nothing anywhere.

## Files

- `index.html`: the app
- `speed-core.js`: the speed and trip engine (no DOM, testable on its own)
- `sw.js`, `manifest.webmanifest`, `icon-*.png`: Home Screen and offline support
- `fonts/`: Barlow and Barlow Condensed, SIL Open Font License (`fonts/OFL.txt`)
