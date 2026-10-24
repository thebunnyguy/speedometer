/*!
 * speed-core.js
 * Turns raw GPS fixes into a steady, accurate speed plus trip totals.
 * No DOM access, so the same code runs in the app and in tests.
 *
 * Accuracy strategy
 *  1. Prefer the GNSS chip's Doppler speed (coords.speed). It is measured from the
 *     frequency shift of the satellite signals, not from position differences, so it
 *     is typically good to a few tenths of a m/s with a clear sky view.
 *  2. If the chip gives no speed, fall back to displacement over the last few
 *     seconds, gated by the reported position accuracy so GPS jitter can't fake motion.
 *  3. A 1-D Kalman filter blends each measurement by its uncertainty. Real vehicles
 *     can't change speed by more than a few m/s per second, so a single fix that jumps
 *     far outside that is held until a second fix confirms it (kills glitch spikes).
 *  4. Distance integrates speed over time (trapezoid rule), which beats summing
 *     noisy position-to-position hops. Signal gaps (tunnels, locked screen) are
 *     bridged with straight-line distance between good fixes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpeedCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EARTH_R = 6371008.8; // mean Earth radius, metres
  var RAD = Math.PI / 180;

  function haversine(a, b) {
    var dLat = (b.lat - a.lat) * RAD;
    var dLon = (b.lon - a.lon) * RAD;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    var p1 = a.lat * RAD, p2 = b.lat * RAD, dl = (b.lon - a.lon) * RAD;
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  var DEFAULTS = {
    accelSigma: 2.5,   // m/s^2: plausible change in true speed per second (process noise)
    stopSpeed: 0.4,    // m/s: below this the speed reads 0 (about 1.4 km/h)
    gapSeconds: 5,     // silence longer than this is a signal gap (tunnel, locked screen)
    outlierSigma: 4,   // jumps beyond this many std devs need a second fix to confirm
    statsAccuracy: 30, // m: only fixes at least this good can set a new max speed
    gapAccuracy: 50,   // m: fixes used to bridge a signal gap must be at least this good
    windowMs: 4000     // look-back for position-derived speed when the chip gives none
  };

  function finite(x) { return typeof x === 'number' && isFinite(x); }

  function create(options) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    if (options) for (k in options) o[k] = options[k];

    var f, trip;

    function newFilter() {
      return {
        v: 0, P: 100, lastT: null, prev: null, hist: [],
        pendingJump: 0, settled: 0, lastTrusted: null,
        accuracy: null, source: null, heading: null, altitude: null, fixes: 0
      };
    }
    function newTrip() { return { max: 0, dist: 0, moving: 0 }; }
    f = newFilter();
    trip = newTrip();

    function shown(v) { return v < o.stopSpeed ? 0 : v; }

    function measure(fx) {
      if (finite(fx.speed) && fx.speed >= 0) {
        var sd = 0.2 + 0.02 * f.accuracy; // ~0.3 m/s at 5 m accuracy, ~0.6 m/s at 20 m
        return { z: fx.speed, R: sd * sd, src: 'doppler' };
      }
      var cur = f.hist[f.hist.length - 1], old = null;
      for (var i = 0; i < f.hist.length - 1; i++) {
        var age = cur.t - f.hist[i].t;
        if (age <= o.windowMs && age >= 1500) { old = f.hist[i]; break; }
      }
      if (!old) return null;
      var dt = (cur.t - old.t) / 1000;
      var d = haversine(old, cur);
      var sigmaD = 0.7 * Math.sqrt(old.acc * old.acc + cur.acc * cur.acc); // spread of the displacement from jitter alone
      var sd2 = sigmaD / dt + 0.3;
      // A parked phone's position wanders by a few metres; only movement well beyond that counts.
      return { z: d > 2.8 * sigmaD ? d / dt : 0, R: sd2 * sd2, src: 'position' };
    }

    function ingest(fx) {
      if (!fx || !finite(fx.t) || !finite(fx.lat) || !finite(fx.lon)) return snapshot();
      if (f.lastT !== null && fx.t <= f.lastT) return snapshot(); // repeated or out-of-order fix

      var acc = finite(fx.acc) && fx.acc > 0 ? fx.acc : 100;
      var dt = f.lastT === null ? 0 : (fx.t - f.lastT) / 1000;
      var gap = f.lastT !== null && dt > o.gapSeconds;
      var vBefore = f.v;

      f.accuracy = acc;
      f.fixes++;
      if (finite(fx.altitude)) f.altitude = fx.altitude;

      f.hist.push({ t: fx.t, lat: fx.lat, lon: fx.lon, acc: acc });
      if (gap) f.hist = [f.hist[f.hist.length - 1]]; // never derive speed across a gap
      while (f.hist.length > 1 && fx.t - f.hist[0].t > o.windowMs + 1000) f.hist.shift();

      var m = measure(fx);
      var accepted = false;
      if (m) {
        if (f.lastT === null || gap) {
          f.v = m.z; f.P = m.R; f.pendingJump = 0; f.settled = 0;
          accepted = true;
        } else {
          var P = f.P + Math.pow(o.accelSigma * dt, 2);
          var innov = m.z - f.v;
          var S = P + m.R;
          var dir = innov > 0 ? 1 : -1;
          var jump = innov * innov > o.outlierSigma * o.outlierSigma * S;
          if (jump && f.pendingJump !== dir) {
            f.pendingJump = dir; // hold: a lone wild fix is usually a glitch
            f.P = P;
          } else if (jump) {
            f.v = m.z; f.P = m.R; f.pendingJump = 0; // confirmed by a second fix
            accepted = true;
          } else {
            var K = P / S;
            f.v += K * innov; f.P = (1 - K) * P; f.pendingJump = 0;
            accepted = true;
          }
        }
        if (f.v < 0) f.v = 0;
        f.source = m.src;
      }
      if (accepted) f.settled++;

      if (f.lastT !== null) {
        if (!gap) {
          var vm = (shown(vBefore) + shown(f.v)) / 2;
          if (vm > 0) { trip.dist += vm * dt; trip.moving += dt; }
        } else if (f.prev && f.prev.acc <= o.gapAccuracy && acc <= o.gapAccuracy) {
          var dGap = haversine(f.prev, fx);
          var noiseGap = Math.sqrt(f.prev.acc * f.prev.acc + acc * acc);
          if (dGap > noiseGap && dGap / dt >= o.stopSpeed) { trip.dist += dGap; trip.moving += dt; }
        }
      }

      var sp = shown(f.v);
      // Max speed must hold for two trustworthy fixes in a row, so one noisy peak can't set it.
      var trusted = accepted && f.settled >= 2 && acc <= o.statsAccuracy;
      if (trusted && f.lastTrusted !== null) {
        var sustained = Math.min(sp, f.lastTrusted);
        if (sustained > trip.max) trip.max = sustained;
      }
      f.lastTrusted = trusted ? sp : null;

      if (finite(fx.heading) && fx.heading >= 0 && sp >= 1) {
        f.heading = fx.heading;
      } else if (sp >= 2 && f.hist.length > 1) {
        var first = f.hist[0];
        if (haversine(first, fx) > Math.max(8, 2 * acc)) f.heading = bearing(first, fx);
      }

      f.prev = { t: fx.t, lat: fx.lat, lon: fx.lon, acc: acc };
      f.lastT = fx.t;
      return snapshot();
    }

    function snapshot() {
      return {
        speed: shown(f.v),
        rawSpeed: f.v,
        sigma: Math.sqrt(f.P),
        max: trip.max,
        distance: trip.dist,
        movingTime: trip.moving,
        average: trip.moving > 0 ? trip.dist / trip.moving : 0,
        heading: f.heading,
        altitude: f.altitude,
        accuracy: f.accuracy,
        source: f.source,
        lastFixTime: f.lastT,
        fixes: f.fixes
      };
    }

    return {
      ingest: ingest,
      snapshot: snapshot,
      resetTrip: function () { trip = newTrip(); return snapshot(); },
      restoreTrip: function (t) {
        if (t && finite(t.max) && finite(t.dist) && finite(t.moving)) {
          trip = { max: t.max, dist: t.dist, moving: t.moving };
        }
        return snapshot();
      },
      tripState: function () { return { max: trip.max, dist: trip.dist, moving: trip.moving }; },
      options: o
    };
  }

  return { create: create, haversine: haversine, bearing: bearing, DEFAULTS: DEFAULTS };
}));
