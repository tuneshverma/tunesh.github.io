/* Voice agent for the portfolio.
 *
 * Connects the visitor to the LiveKit agent that answers as Tunesh. The SDK is
 * loaded on first use rather than at page load, so visitors who never start a
 * call pay nothing for the feature.
 *
 * The token endpoint is read from this script tag's data-token-endpoint
 * attribute. It signs the LiveKit JWT server-side; nothing secret lives here.
 */
(function () {
  "use strict";

  var SDK_URL = "voice/livekit-client.umd.js";
  var script = document.currentScript;
  var TOKEN_ENDPOINT = script && script.dataset.tokenEndpoint;

  var TAU = Math.PI * 2;
  // The hero orb tilts its two rings to these angles. Reusing them is what
  // makes the call visual read as the same object, woken up.
  var RING_A = (20 * Math.PI) / 180;
  var RING_B = (-35 * Math.PI) / 180;

  var COLORS = {
    idle: [146, 156, 171],
    listening: [66, 232, 195],
    speaking: [124, 140, 255],
  };

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var state = {
    phase: "idle", // idle | connecting | live | ended | error
    speaking: false,
    muted: false,
    level: 0,
    color: COLORS.idle.slice(),
  };

  var room = null;
  var audioCtx = null;
  var agentAnalyser = null;
  var micAnalyser = null;
  var attachedAudio = [];
  var rafId = null;
  var sdkPromise = null;
  var lastFocus = null;

  /* ---------------------------------------------------------------- markup */

  var overlay = document.createElement("div");
  overlay.className = "va-overlay";
  overlay.dataset.open = "false";
  overlay.dataset.phase = "idle";
  overlay.innerHTML = [
    '<div class="va-panel" role="dialog" aria-modal="true"',
    '     aria-label="Voice chat with Tunesh\'s AI">',
    '  <button class="va-close" type="button" aria-label="Close">&#10005;</button>',
    '  <div class="va-eyebrow">Tunesh&rsquo;s AI</div>',
    '  <p class="va-sub">Answers from my portfolio and r&eacute;sum&eacute;.</p>',
    '  <div class="va-stage"><canvas class="va-canvas"></canvas></div>',
    '  <div class="va-status" role="status" aria-live="polite">Connecting&hellip;</div>',
    '  <p class="va-caption"></p>',
    '  <p class="va-error" role="alert"></p>',
    '  <div class="va-controls">',
    '    <button class="va-btn va-mute" type="button" aria-pressed="false" disabled>Mute</button>',
    '    <button class="va-btn va-end" type="button" disabled>End call</button>',
    '    <button class="va-btn va-retry" type="button">Try again</button>',
    "  </div>",
    "</div>",
  ].join("");
  document.body.appendChild(overlay);

  var panel = overlay.querySelector(".va-panel");
  var canvas = overlay.querySelector(".va-canvas");
  var statusEl = overlay.querySelector(".va-status");
  var captionEl = overlay.querySelector(".va-caption");
  var errorEl = overlay.querySelector(".va-error");
  var muteBtn = overlay.querySelector(".va-mute");
  var endBtn = overlay.querySelector(".va-end");
  var retryBtn = overlay.querySelector(".va-retry");
  var closeBtn = overlay.querySelector(".va-close");
  var ctx = canvas.getContext("2d");

  /* ------------------------------------------------------------- rendering */

  function sizeCanvas() {
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return rect.width;
  }

  // Each analyser keeps its own buffer. Sharing one would leave the sphere's
  // deformation driven by whichever source was sampled last rather than by
  // whoever is actually talking.
  var buffers = new WeakMap();

  function sample(analyser) {
    if (!analyser) return null;
    var data = buffers.get(analyser);
    if (!data || data.length !== analyser.frequencyBinCount) {
      data = new Uint8Array(analyser.frequencyBinCount);
      buffers.set(analyser, data);
    }
    analyser.getByteFrequencyData(data);
    var sum = 0;
    // Speech energy sits in the lower bins; averaging the whole spectrum
    // flattens the response until the sphere barely moves.
    var usable = Math.floor(data.length * 0.45);
    for (var i = 0; i < usable; i++) sum += data[i];
    return { level: Math.min(1, sum / usable / 165), data: data };
  }

  function mix(from, to, t) {
    return [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    ];
  }

  function lift(color, amount) {
    return mix(color, [255, 255, 255], amount);
  }

  function rgba(color, alpha) {
    return (
      "rgba(" +
      Math.round(color[0]) +
      "," +
      Math.round(color[1]) +
      "," +
      Math.round(color[2]) +
      "," +
      alpha +
      ")"
    );
  }

  /* The entity: three overlapping blobs whose outlines are modulated by three
     sine waves at different frequencies. The frequencies are not multiples of
     one another, so the silhouette never repeats.

     The same renderer paints the launcher and the call panel. In the launcher
     it is clipped to a circle — a contained thing, pressing against the glass.
     In the call it runs unclipped, the same creature let out into the room. */

  var BLOBS = [
    { seed: 0.0, amp: 0.13, scale: 0.94, alpha: 0.95, drift: 1.0, tint: 0.0 },
    { seed: 2.1, amp: 0.17, scale: 0.82, alpha: 0.6, drift: -0.72, tint: 0.55 },
    { seed: 4.3, amp: 0.2, scale: 0.66, alpha: 0.5, drift: 1.45, tint: 1.0 },
  ];

  function blobPath(c, cx, cy, radius, t, blob, amp) {
    var points = 84;
    c.beginPath();
    for (var i = 0; i <= points; i++) {
      var a = (i / points) * TAU;
      var wave =
        Math.sin(a * 3 + t * 1.1 * blob.drift + blob.seed) * 0.5 +
        Math.sin(a * 5 - t * 0.83 * blob.drift + blob.seed * 1.7) * 0.32 +
        Math.sin(a * 2 + t * 0.61 * blob.drift + blob.seed * 2.3) * 0.18;
      var r = radius * (1 + amp * wave);
      var x = cx + Math.cos(a) * r;
      var y = cy + Math.sin(a) * r;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
  }

  function drawEntity(c, size, opts) {
    var t = reduceMotion.matches ? 3.4 : opts.t;
    var energy = opts.energy || 0;
    var glow = opts.glow || 0;
    var cx = size / 2;
    var cy = size / 2;
    var base = size * opts.radius * (1 + energy * 0.26 + glow * 0.05);

    c.clearRect(0, 0, size, size);

    if (opts.clip) {
      // Backing disc, so the circle never reads as a flat swatch.
      var bg = c.createRadialGradient(cx, cy, 0, cx, cy, size * 0.5);
      bg.addColorStop(0, "rgba(19,25,38,1)");
      bg.addColorStop(1, "rgba(9,12,18,1)");
      c.fillStyle = bg;
      c.beginPath();
      c.arc(cx, cy, size * 0.5, 0, TAU);
      c.fill();
      c.save();
      c.clip();
    } else {
      c.save();
    }

    var halo = c.createRadialGradient(cx, cy, base * 0.2, cx, cy, size * 0.54);
    halo.addColorStop(0, rgba(opts.colorA, 0.2 + energy * 0.22 + glow * 0.12));
    halo.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = halo;
    c.fillRect(0, 0, size, size);

    // Additive blending: where the blobs overlap the colour builds, which is
    // what gives the liquid look rather than three flat shapes stacked up.
    c.globalCompositeOperation = "lighter";
    for (var i = 0; i < BLOBS.length; i++) {
      var b = BLOBS[i];
      var color = lift(mix(opts.colorA, opts.colorB, b.tint), glow * 0.2);
      var ox = Math.cos(t * 0.37 * b.drift + b.seed) * size * 0.035;
      var oy = Math.sin(t * 0.29 * b.drift + b.seed * 1.4) * size * 0.035;
      var r = base * b.scale;
      blobPath(c, cx + ox, cy + oy, r, t, b, b.amp * (1 + energy * 1.3));

      var g = c.createRadialGradient(
        cx + ox - r * 0.32, cy + oy - r * 0.36, r * 0.05,
        cx + ox, cy + oy, r * 1.25,
      );
      g.addColorStop(0, rgba(lift(color, 0.45), b.alpha));
      g.addColorStop(0.55, rgba(color, b.alpha * 0.55));
      g.addColorStop(1, rgba(color, 0));
      c.fillStyle = g;
      c.fill();
    }
    c.globalCompositeOperation = "source-over";
    c.restore();

    if (opts.clip) {
      c.beginPath();
      c.arc(cx, cy, size * 0.5 - 0.5, 0, TAU);
      c.strokeStyle = rgba(mix(opts.colorA, opts.colorB, 0.5), 0.3 + glow * 0.35);
      c.lineWidth = 1;
      c.stroke();
    }
  }

  function frame(now) {
    var size = canvas.clientWidth ? canvas.width / (window.devicePixelRatio || 1) : 0;
    if (!size) {
      rafId = requestAnimationFrame(frame);
      return;
    }

    var agent = sample(agentAnalyser);
    var mic = state.muted ? null : sample(micAnalyser);
    var agentLevel = agent ? agent.level : 0;
    var micLevel = mic ? mic.level : 0;

    // Hysteresis, so a breath between words doesn't flip the label.
    if (agentLevel > 0.12) state.speaking = true;
    else if (agentLevel < 0.05) state.speaking = false;

    var target =
      state.phase !== "live"
        ? COLORS.idle
        : state.speaking
          ? COLORS.speaking
          : state.muted
            ? COLORS.idle
            : COLORS.listening;

    state.color = mix(state.color, target, 0.08);

    // The sphere reacts to whoever holds the floor, so the deformation always
    // matches the voice the caller is hearing.
    var source = state.speaking ? agent : mic;
    var active = source ? source.level : 0;
    state.level += (active - state.level) * 0.22;

    drawEntity(ctx, size, {
      t: now / 1000,
      colorA: state.color,
      colorB: lift(state.color, 0.42),
      energy: state.level,
      glow: 0,
      radius: 0.3,
      clip: false,
    });

    rafId = requestAnimationFrame(frame);
  }

  function startRendering() {
    sizeCanvas();
    if (rafId === null) rafId = requestAnimationFrame(frame);
  }

  function stopRendering() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* ----------------------------------------------------------------- state */

  // Phase drives both the copy and which controls are on screen, so it is
  // mirrored onto the overlay for CSS to key off.
  function setPhase(phase) {
    state.phase = phase;
    overlay.dataset.phase = phase;
    // "Try again" belongs to a failure. A call the visitor chose to end is not
    // a failure, so the same button invites another question instead.
    if (phase === "ended") retryBtn.textContent = "Ask again";
    else if (phase === "error") retryBtn.textContent = "Try again";
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function setError(text) {
    errorEl.textContent = text || "";
  }

  function refreshStatus() {
    if (state.phase === "connecting") return setStatus("Connecting…");
    if (state.phase === "ended") return setStatus("Call ended");
    if (state.phase === "error") return setStatus("Not connected");
    if (state.muted) return setStatus("Microphone off");
    setStatus(state.speaking ? "Speaking" : "Listening");
  }

  /* ------------------------------------------------------------- SDK + room */

  function loadSdk() {
    if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve, reject) {
      var tag = document.createElement("script");
      tag.src = SDK_URL;
      tag.onload = function () {
        window.LivekitClient
          ? resolve(window.LivekitClient)
          : reject(new Error("SDK loaded but LivekitClient is missing"));
      };
      tag.onerror = function () {
        sdkPromise = null;
        reject(new Error("Could not load the voice SDK"));
      };
      document.head.appendChild(tag);
    });
    return sdkPromise;
  }

  function ensureAudioContext() {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtx) audioCtx = new Ctor();
    // Browsers start the context suspended until a user gesture; open() is
    // always called from a click, so this is the moment it can resume.
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function attachAnalyser(mediaStreamTrack) {
    var actx = ensureAudioContext();
    if (!actx || !mediaStreamTrack) return null;
    try {
      var source = actx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
      var analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      // Deliberately not connected to destination — the <audio> element the
      // SDK attaches handles playback, and connecting here would double it.
      source.connect(analyser);
      return analyser;
    } catch (err) {
      return null;
    }
  }

  function showCaption(text, isFinal) {
    if (!text) return;
    captionEl.textContent = text;
    if (isFinal) {
      clearTimeout(showCaption.timer);
      showCaption.timer = setTimeout(function () {
        captionEl.textContent = "";
      }, 6000);
    }
  }

  function wireTranscripts(LK, activeRoom) {
    try {
      activeRoom.on(LK.RoomEvent.TranscriptionReceived, function (segments) {
        var last = segments[segments.length - 1];
        if (last) showCaption(last.text, last.final);
      });
    } catch (err) {
      /* Captions are supplementary; a missing event must not break the call. */
    }

    try {
      activeRoom.registerTextStreamHandler("lk.transcription", function (reader) {
        reader.readAll().then(function (text) {
          showCaption(text, true);
        });
      });
    } catch (err) {
      /* Older SDKs only emit the event above. */
    }
  }

  // A short tail on the error message. Without it a failed call is a dead end
  // for the visitor and unreportable for us.
  function detail(err) {
    var text = (err && (err.message || err.name)) || "";
    return text ? "(" + String(text).slice(0, 90) + ")" : "Try again in a moment.";
  }

  function micMessage(LK, err) {
    var failure = null;
    try {
      failure = LK.MediaDeviceFailure.getFailure(err);
    } catch (e) {
      /* helper missing on older SDKs; fall through to the generic message */
    }
    if (failure === "PermissionDenied") {
      return "Microphone access is blocked. Allow it in your browser settings, then try again.";
    }
    if (failure === "NotFound") {
      return "No microphone found. Connect one and try again.";
    }
    if (failure === "DeviceInUse") {
      return "Your microphone is in use by another app. Close it and try again.";
    }
    return "Couldn't open your microphone. " + detail(err);
  }

  async function connect() {
    if (!TOKEN_ENDPOINT) {
      setPhase("error");
      refreshStatus();
      setError(
        "This site has no token endpoint configured yet, so the call can't start.",
      );
      return;
    }

    setPhase("connecting");
    state.muted = false;
    refreshStatus();
    setError("");
    captionEl.textContent = "";

    var LK;
    try {
      LK = await loadSdk();
    } catch (err) {
      setPhase("error");
      refreshStatus();
      setError("Couldn't load the voice SDK. Check your connection and try again.");
      return;
    }

    var details;
    try {
      var response = await fetch(TOKEN_ENDPOINT, { method: "POST" });
      if (response.status === 429) {
        setPhase("error");
        refreshStatus();
        setError("Too many calls from your network just now. Try again in a minute.");
        return;
      }
      if (!response.ok) throw new Error("token endpoint returned " + response.status);
      details = await response.json();
    } catch (err) {
      console.error("[voice] token request failed:", err);
      setPhase("error");
      refreshStatus();
      setError("Couldn't reach the call service. Check your connection and try again.");
      return;
    }

    room = new LK.Room({ adaptiveStream: true, dynacast: true });

    room.on(LK.RoomEvent.TrackSubscribed, function (track) {
      if (track.kind !== "audio") return;
      // Attaching returns an <audio> element that must stay in the DOM for
      // playback to continue.
      var el = track.attach();
      el.style.display = "none";
      document.body.appendChild(el);
      attachedAudio.push(el);
      agentAnalyser = attachAnalyser(track.mediaStreamTrack);
    });

    room.on(LK.RoomEvent.Disconnected, function () {
      teardown("Call ended");
    });

    wireTranscripts(LK, room);

    // Joining the room and opening the microphone fail for entirely different
    // reasons, so they are reported separately rather than as one vague error.
    try {
      await room.connect(details.url, details.token);
    } catch (err) {
      console.error("[voice] room.connect failed:", err);
      teardown(null);
      setPhase("error");
      refreshStatus();
      setError("Couldn't reach the call server. " + detail(err));
      return;
    }

    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (err) {
      console.error("[voice] microphone failed:", err);
      teardown(null);
      setPhase("error");
      refreshStatus();
      setError(micMessage(LK, err));
      return;
    }

    var micPub = room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
    if (micPub && micPub.track) {
      micAnalyser = attachAnalyser(micPub.track.mediaStreamTrack);
    }

    setPhase("live");
    muteBtn.disabled = false;
    endBtn.disabled = false;
    refreshStatus();
  }

  function teardown(endMessage) {
    if (room) {
      try {
        room.disconnect();
      } catch (err) {
        /* already gone */
      }
      room = null;
    }
    attachedAudio.forEach(function (el) {
      el.remove();
    });
    attachedAudio.length = 0;
    agentAnalyser = null;
    micAnalyser = null;
    state.speaking = false;
    state.muted = false;
    muteBtn.disabled = true;
    muteBtn.setAttribute("aria-pressed", "false");
    muteBtn.textContent = "Mute";
    endBtn.disabled = true;
    if (endMessage) {
      setPhase("ended");
      refreshStatus();
    }
  }

  /* -------------------------------------------------------------- controls */

  function focusable() {
    return Array.prototype.filter.call(
      panel.querySelectorAll("button"),
      function (el) {
        return !el.disabled;
      },
    );
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    var items = focusable();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function open() {
    lastFocus = document.activeElement;
    overlay.dataset.open = "true";
    document.body.classList.add("va-open");
    document.addEventListener("keydown", onKeydown);
    startRendering();
    closeBtn.focus();
    connect();
  }

  function close() {
    teardown(null);
    stopRendering();
    overlay.dataset.open = "false";
    document.body.classList.remove("va-open");
    document.removeEventListener("keydown", onKeydown);
    setPhase("idle");
    setError("");
    captionEl.textContent = "";
    setStatus("Connecting…");
    // Safari and Firefox don't focus a button on click, so lastFocus is often
    // <body>, which can't take focus. Fall back to the launcher so closing the
    // panel never strands keyboard focus at the top of the document.
    var target =
      lastFocus && lastFocus.focus && lastFocus !== document.body ? lastFocus : fab;
    if (target && target.focus) target.focus();
  }

  muteBtn.addEventListener("click", function () {
    if (!room) return;
    state.muted = !state.muted;
    room.localParticipant.setMicrophoneEnabled(!state.muted);
    muteBtn.setAttribute("aria-pressed", String(state.muted));
    muteBtn.textContent = state.muted ? "Unmute" : "Mute";
    refreshStatus();
  });

  endBtn.addEventListener("click", function () {
    teardown("Call ended");
  });

  retryBtn.addEventListener("click", function () {
    connect();
  });

  closeBtn.addEventListener("click", close);

  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) close();
  });

  window.addEventListener("resize", function () {
    if (overlay.dataset.open === "true") sizeCanvas();
  });

  // Built here rather than in index.html so the button only exists when the
  // script that powers it has actually run. A hardcoded one would sit there
  // looking clickable even if this file failed to load.
  var fab = document.createElement("button");
  fab.className = "va-fab";
  fab.type = "button";
  fab.setAttribute("aria-label", "Talk to my AI");
  fab.innerHTML = [
    '<span class="va-fab-orb-wrap">',
    '  <canvas class="va-fab-orb" aria-hidden="true"></canvas>',
    "</span>",
    '<span class="va-fab-label">Talk to my AI</span>',
  ].join("");
  fab.addEventListener("click", open);
  document.body.appendChild(fab);

  /* ------------------------------------------------ the living entity

     Three translucent blobs, each an ellipse whose radius is modulated by
     three sine waves at different frequencies and drift speeds. Because the
     frequencies are not multiples of one another the silhouette never
     repeats, which is what stops it reading as a looping animation. */

  var orbWrap = fab.querySelector(".va-fab-orb-wrap");
  var miniCanvas = fab.querySelector(".va-fab-orb");
  var miniCtx = miniCanvas.getContext("2d");
  var miniSize = 0;
  var miniHover = 0;
  var miniGlow = 0;

  function sizeMini() {
    var rect = miniCanvas.getBoundingClientRect();
    if (!rect.width) return 0;
    var dpr = window.devicePixelRatio || 1;
    miniCanvas.width = Math.round(rect.width * dpr);
    miniCanvas.height = Math.round(rect.height * dpr);
    miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    miniSize = rect.width;
    return miniSize;
  }

  function miniFrame(now) {
    requestAnimationFrame(miniFrame);
    if (!miniSize && !sizeMini()) return;
    // Hidden, or behind the call panel: nothing worth painting.
    if (document.body.classList.contains("va-open")) return;
    if (fab.classList.contains("va-fab--hidden")) return;

    miniGlow += (miniHover - miniGlow) * 0.12;

    drawEntity(miniCtx, miniSize, {
      t: now / 1000,
      colorA: COLORS.listening,
      colorB: COLORS.speaking,
      energy: 0,
      glow: miniGlow,
      radius: 0.3,
      clip: true,
    });
  }

  ["mouseenter", "focus"].forEach(function (evt) {
    fab.addEventListener(evt, function () { miniHover = 1; });
  });
  ["mouseleave", "blur"].forEach(function (evt) {
    fab.addEventListener(evt, function () { miniHover = 0; });
  });

  requestAnimationFrame(miniFrame);

  /* ------------------------------------------------- launcher travel

     hidden   — still above the slot, so no button exists yet
     anchored — slot is on screen, button sits in it at full size
     docked    — scrolled past, shrunk into the bottom-right corner */

  var anchor = document.querySelector(".va-anchor");
  // The corner circle is a fixed size regardless of how big the full-size
  // button is, so changing the hero size (or the mobile breakpoint) never
  // changes what the docked launcher looks like.
  var DOCK_DIAMETER = 58;
  var travelState = null;
  var travelTimer = null;
  var queued = false;

  function placeFab() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var w = fab.offsetWidth;
    var h = fab.offsetHeight;
    if (!w || !h || !anchor) return;

    var r = anchor.getBoundingClientRect();
    var next;
    if (r.top > vh * 0.94) next = "hidden";
    else if (r.bottom < vh * 0.18) next = "docked";
    else next = "anchored";

    var orbW = orbWrap.offsetWidth || 1;
    var dockScale = DOCK_DIAMETER / orbW;
    var x;
    var y;

    if (next === "docked") {
      // Position the circle, not the whole button: the label is invisible when
      // docked, and measuring the box would leave its empty space between the
      // circle and the corner.
      var m = vw < 560 ? 18 : 24;
      var ocx = orbWrap.offsetLeft + orbW / 2;
      var ocy = orbWrap.offsetTop + orbWrap.offsetHeight / 2;
      // Rendered orb centre = buttonCentre + (orbCentre - buttonCentre) * scale
      x = vw - m - DOCK_DIAMETER / 2 - w / 2 - (ocx - w / 2) * dockScale;
      y = vh - m - DOCK_DIAMETER / 2 - h / 2 - (ocy - h / 2) * dockScale;
    } else {
      x = r.left + r.width / 2 - w / 2;
      y = r.top + r.height / 2 - h / 2;
    }

    if (next !== travelState) {
      var wasHidden = travelState === null || travelState === "hidden";
      travelState = next;
      fab.classList.toggle("va-fab--hidden", next === "hidden");
      fab.classList.toggle("va-fab--docked", next === "docked");
      // Don't animate a journey from nowhere — the first appearance should
      // fade in at full size, not fly in from a stale position.
      if (!wasHidden) {
        fab.classList.add("va-fab--moving");
        clearTimeout(travelTimer);
        travelTimer = setTimeout(function () {
          fab.classList.remove("va-fab--moving");
        }, 800);
      }
    }

    fab.style.transform =
      "translate(" + Math.round(x) + "px," + Math.round(y) + "px) scale(" +
      (next === "docked" ? dockScale.toFixed(4) : 1) + ")";
  }

  function scheduleFab() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      placeFab();
    });
  }

  window.addEventListener("scroll", scheduleFab, { passive: true });
  window.addEventListener("resize", scheduleFab);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleFab);
  }
  placeFab();

  document.querySelectorAll("[data-va-open]").forEach(function (el) {
    el.addEventListener("click", function (event) {
      event.preventDefault();
      open();
    });
    el.addEventListener("keydown", function (event) {
      if (el.tagName !== "BUTTON" && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        open();
      }
    });
  });
})();
