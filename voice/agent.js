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

  /* The agent deployment sleeps when idle and takes 10-20 seconds to come
     back, during which the room is joined, the microphone is open and
     absolutely nobody is listening. These bound how long the panel waits on
     it, and when the copy stops being breezy about it. */
  var WARM_PATH = "/warm";
  var AGENT_SLOW_AFTER = 7000;
  var AGENT_WAIT_TIMEOUT = 45000;
  /** One warm ping per tab per this long. The Worker throttles globally too. */
  var WARM_INTERVAL = 120000;

  /* Published by the agent session on its participant. Anything in READY
     means a pipeline is running and speech will actually be heard;
     "initializing" explicitly does not. */
  var AGENT_STATE_ATTR = "lk.agent.state";
  var AGENT_READY = { idle: 1, listening: 1, thinking: 1, speaking: 1 };

  var TAU = Math.PI * 2;
  // The hero orb tilts its two rings to these angles. Reusing them is what
  // makes the call visual read as the same object, woken up.
  var RING_A = (20 * Math.PI) / 180;
  var RING_B = (-35 * Math.PI) / 180;

  var COLORS = {
    idle: [146, 156, 171],
    listening: [66, 232, 195],
    speaking: [124, 140, 255],
    // Deliberately darker and flatter than idle. Waiting has to be readable
    // as a different thing from a live call that happens to be quiet.
    waking: [78, 88, 104],
  };

  // The entity is drawn small and dim while waiting and full size once the
  // agent is really there, so "it has woken up" is a change you can see from
  // across the room rather than a word that changed in the status line.
  var RADIUS_WAITING = 0.15;
  var RADIUS_LIVE = 0.3;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var state = {
    // idle | ready | connecting | waking | live | ended | error
    //
    // "waking" is the one that matters: the room is joined but the agent is
    // not in it yet. Treating that as live is what used to leave visitors
    // talking to nobody.
    phase: "idle",
    speaking: false,
    muted: false,
    slow: false,
    level: 0,
    color: COLORS.idle.slice(),
    radius: RADIUS_WAITING,
    ring: 0,
    // Advanced by hand rather than read off the clock, so slowing the entity
    // down while it waits changes its speed without jumping its phase.
    clock: 0,
  };

  var room = null;
  var audioCtx = null;
  var agentAnalyser = null;
  var micAnalyser = null;
  var attachedAudio = [];
  var rafId = null;
  var lastFrameAt = 0;
  var sdkPromise = null;
  var lastFocus = null;
  var agentAudioLive = false;
  var slowTimer = null;
  var waitTimer = null;
  var lastWarm = 0;

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
    '  <p class="va-hint"></p>',
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
  var hintEl = overlay.querySelector(".va-hint");
  var captionEl = overlay.querySelector(".va-caption");
  var errorEl = overlay.querySelector(".va-error");
  var muteBtn = overlay.querySelector(".va-mute");
  var endBtn = overlay.querySelector(".va-end");
  var retryBtn = overlay.querySelector(".va-retry");
  var closeBtn = overlay.querySelector(".va-close");
  var ctx = canvas.getContext("2d");

  /* ------------------------------------------------------------- rendering */

  var MAX_DPR = 2;

  function sizeCanvas() {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
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

    // Dimmed while the agent is still booting, so the ring around it is what
    // the eye goes to. The creature is there, but it is not the subject yet.
    // Set after save() so that nothing drawn afterwards inherits it.
    c.globalAlpha = opts.dim === undefined ? 1 : opts.dim;

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

  /* The ring only ever appears while the agent is being waited on, so it is
     the one unambiguous "not yet" marker on screen: ring turning, nothing is
     listening. It is indeterminate on purpose — a cold start is 10 seconds or
     25 depending on the day, and a bar that lies about which is worse than
     one that admits it doesn't know. */
  function drawWaitRing(c, size, alpha) {
    if (alpha < 0.01) return;
    var cx = size / 2;
    var cy = size / 2;
    var r = size * 0.33;

    c.save();
    c.lineWidth = Math.max(2, size * 0.011);
    c.lineCap = "round";

    c.beginPath();
    c.arc(cx, cy, r, 0, TAU);
    c.strokeStyle = rgba(COLORS.idle, 0.14 * alpha);
    c.stroke();

    if (reduceMotion.matches) {
      // A still ring with a gap in it still reads as "in progress" without
      // anything moving, which is the whole point of the preference.
      c.beginPath();
      c.arc(cx, cy, r, -Math.PI / 2, Math.PI * 0.55);
      c.strokeStyle = rgba(COLORS.listening, 0.5 * alpha);
      c.stroke();
    } else {
      var head = (state.clock * 1.25) % 1;
      var start = head * TAU - Math.PI / 2;
      c.beginPath();
      c.arc(cx, cy, r, start, start + TAU * 0.24);
      c.strokeStyle = rgba(COLORS.listening, 0.72 * alpha);
      c.stroke();
    }
    c.restore();
  }

  function frame(now) {
    var size = canvas.clientWidth ? canvas.width / (window.devicePixelRatio || 1) : 0;
    if (!size) {
      rafId = requestAnimationFrame(frame);
      return;
    }

    var waiting = state.phase === "connecting" || state.phase === "waking";

    // Clamped so a backgrounded tab returning doesn't jump the animation a
    // whole second forward.
    var dt = lastFrameAt ? Math.min(0.05, (now - lastFrameAt) / 1000) : 0;
    lastFrameAt = now;
    // Barely moving while it waits: the creature is asleep, not idling.
    state.clock += dt * (waiting ? 0.22 : 1);

    var agent = sample(agentAnalyser);
    var mic = state.muted ? null : sample(micAnalyser);
    var agentLevel = agent ? agent.level : 0;

    // Hysteresis, so a breath between words doesn't flip the label.
    if (agentLevel > 0.12) state.speaking = true;
    else if (agentLevel < 0.05) state.speaking = false;

    var target = waiting
      ? COLORS.waking
      : state.phase !== "live"
        ? COLORS.idle
        : state.speaking
          ? COLORS.speaking
          : state.muted
            ? COLORS.idle
            : COLORS.listening;

    state.color = mix(state.color, target, 0.08);
    state.radius += ((waiting ? RADIUS_WAITING : RADIUS_LIVE) - state.radius) * 0.08;
    state.ring += ((waiting ? 1 : 0) - state.ring) * 0.12;

    // The sphere reacts to whoever holds the floor, so the deformation always
    // matches the voice the caller is hearing. Nobody holds the floor while
    // the agent is still booting, so it holds perfectly still — audio arriving
    // before then is the microphone warming up, not a conversation.
    var source = state.speaking ? agent : mic;
    var active = waiting ? 0 : source ? source.level : 0;
    state.level += (active - state.level) * 0.22;

    drawEntity(ctx, size, {
      t: state.clock,
      colorA: state.color,
      colorB: lift(state.color, 0.42),
      energy: state.level,
      glow: 0,
      radius: state.radius,
      dim: 1 - state.ring * 0.62,
      clip: false,
    });
    drawWaitRing(ctx, size, state.ring);

    rafId = requestAnimationFrame(frame);
  }

  function startRendering() {
    sizeCanvas();
    if (rafId === null) rafId = requestAnimationFrame(frame);
  }

  function stopRendering() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    lastFrameAt = 0;
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
    else if (phase === "ready") retryBtn.textContent = "Start call";
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  // The hint carries the one thing the status label cannot: what the visitor
  // should do about it. It lives above the caption so a late transcript never
  // shoves it around.
  function setHint(text) {
    hintEl.textContent = text || "";
  }

  function setError(text) {
    errorEl.textContent = text || "";
  }

  function refreshStatus() {
    if (state.phase === "ready") return setStatus("Ready when you are");
    if (state.phase === "connecting") return setStatus("Connecting…");
    if (state.phase === "waking") {
      return setStatus(state.slow ? "Still waking up…" : "Waking up my AI…");
    }
    if (state.phase === "ended") return setStatus("Call ended");
    if (state.phase === "error") return setStatus("Not connected");
    if (state.muted) return setStatus("Microphone off");
    setStatus(state.speaking ? "Speaking" : "Listening");
  }

  /* -------------------------------------------------- is anyone there yet?

     Joining the room is not the same event as the agent being able to hear
     you, and on a deployment that sleeps when idle the gap between them is
     ten to twenty seconds. The panel used to close that gap by assuming:
     room connected, therefore listening. Visitors spoke into it and nothing
     came back.

     So readiness is now something the agent itself says. Its session
     publishes `lk.agent.state` on its participant and moves it off
     "initializing" once the pipeline is actually running. Its audio track
     going live says the same thing and is what arrives if an SDK or agent
     version ever stops publishing the attribute, so either will do. */

  function agentStateOf(participant) {
    var attrs = participant && participant.attributes;
    return (attrs && attrs[AGENT_STATE_ATTR]) || "";
  }

  function findAgent(activeRoom) {
    var found = null;
    activeRoom.remoteParticipants.forEach(function (participant) {
      if (!found && participant.isAgent) found = participant;
    });
    return found;
  }

  function clearWaitTimers() {
    clearTimeout(slowTimer);
    clearTimeout(waitTimer);
    slowTimer = null;
    waitTimer = null;
  }

  function goLive() {
    if (state.phase !== "waking") return;
    clearWaitTimers();
    setPhase("live");
    setHint("");
    muteBtn.disabled = false;
    endBtn.disabled = false;
    endBtn.textContent = "End call";
    refreshStatus();
  }

  function checkAgentReady() {
    if (!room || state.phase !== "waking") return;
    var agent = findAgent(room);
    if (!agent) return;
    if (AGENT_READY[agentStateOf(agent)] || agentAudioLive) goLive();
  }

  /* Nothing in the SDK tells us a dispatch is never coming — a job that
     crashed on boot and one that is still booting look identical from here.
     Only the clock separates them. */
  function startWaiting() {
    clearWaitTimers();
    setPhase("waking");
    state.slow = false;
    refreshStatus();
    setHint("Hold on — it can\u2019t hear you yet.");
    // Cancelling a call that has not started is not ending one.
    endBtn.disabled = false;
    endBtn.textContent = "Cancel";
    muteBtn.disabled = true;

    slowTimer = setTimeout(function () {
      state.slow = true;
      refreshStatus();
      setHint(
        "My AI server sleeps when nobody is using it. Waking it takes ten to " +
          "twenty seconds — it will say hello as soon as it is up.",
      );
    }, AGENT_SLOW_AFTER);

    waitTimer = setTimeout(function () {
      teardown(null);
      setPhase("error");
      refreshStatus();
      setHint("");
      setError(
        "My AI didn\u2019t pick up. It was most likely still starting — try " +
          "again and it should come straight through.",
      );
    }, AGENT_WAIT_TIMEOUT);
  }

  /* ------------------------------------------------------------ prewarming

     The deployment scales to zero when idle, so the first caller of the hour
     pays for a container to boot before anyone answers. This asks the Worker
     to wake it as soon as somebody looks like a plausible caller, so the boot
     overlaps with them reading the page rather than with them sitting in
     front of a dead line.

     Fire and forget, on purpose. It is an optimisation: if it fails, or is
     throttled, or the visitor never calls, nothing on the page changes. The
     Worker decides how often a ping actually becomes a dispatch, so being
     too eager here costs a request rather than compute. */

  var WARM_KEY = "va-warmed-at";

  function warmedAt() {
    if (lastWarm) return lastWarm;
    // Survives index.html -> work.html, where this script loads again from
    // scratch but the deployment it woke is still warm.
    try {
      return Number(window.sessionStorage.getItem(WARM_KEY)) || 0;
    } catch (err) {
      return 0; // private mode, or storage blocked
    }
  }

  function warm() {
    if (!TOKEN_ENDPOINT) return;
    var now = Date.now();
    if (now - warmedAt() < WARM_INTERVAL) return;
    lastWarm = now;
    try {
      window.sessionStorage.setItem(WARM_KEY, String(now));
    } catch (err) {
      /* the in-memory copy still dedupes for the rest of this page */
    }

    var endpoint;
    try {
      endpoint = new URL(WARM_PATH, TOKEN_ENDPOINT).toString();
    } catch (err) {
      return;
    }
    fetch(endpoint, { method: "POST" }).catch(function () {
      /* nothing to recover: the visitor just pays the cold start */
    });
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
    state.slow = false;
    agentAudioLive = false;
    refreshStatus();
    setHint("");
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

    room.on(LK.RoomEvent.TrackSubscribed, function (track, publication, participant) {
      if (track.kind !== "audio") return;
      // Attaching returns an <audio> element that must stay in the DOM for
      // playback to continue.
      var el = track.attach();
      el.style.display = "none";
      document.body.appendChild(el);
      attachedAudio.push(el);
      agentAnalyser = attachAnalyser(track.mediaStreamTrack);
      // The session only publishes once it is running, so this is the second
      // readiness signal and the one that does not depend on attributes.
      if (participant && participant.isAgent) {
        agentAudioLive = true;
        checkAgentReady();
      }
    });

    // Either of these can be the moment the agent becomes reachable: it may
    // join already running, or join and flip its state a beat later.
    room.on(LK.RoomEvent.ParticipantConnected, checkAgentReady);
    room.on(LK.RoomEvent.ParticipantAttributesChanged, checkAgentReady);

    room.on(LK.RoomEvent.Disconnected, function () {
      // This fires a beat after we disconnect the room ourselves, which we do
      // when reporting a failure and when the visitor closes the panel. In
      // neither case is "Call ended" the truth, and arriving last it would
      // otherwise be the label left on screen.
      if (state.phase !== "live" && state.phase !== "waking") return;
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

    // The microphone is left open through the wait on purpose: the permission
    // prompt and the echo canceller's warmup both want to happen now rather
    // than at the moment the agent finally speaks. The panel just has to be
    // honest that nothing is listening to it yet.
    startWaiting();
    // The agent can beat us into the room — on a warm deployment it usually
    // does — and then no event ever fires, because it all happened already.
    checkAgentReady();
  }

  function teardown(endMessage) {
    clearWaitTimers();
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
    agentAudioLive = false;
    state.speaking = false;
    state.muted = false;
    state.slow = false;
    muteBtn.disabled = true;
    muteBtn.setAttribute("aria-pressed", "false");
    muteBtn.textContent = "Mute";
    endBtn.disabled = true;
    endBtn.textContent = "End call";
    setHint("");
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

  /* Opening from a click carries a user gesture, so the call can start at once.
     Opening from a link does not, and browsers gate the microphone behind one —
     Safari refuses outright, and audio playback can be blocked elsewhere. So a
     deep link waits on a single button unless the microphone is already
     granted for this site, in which case it just connects. */

  function startWhenAllowed() {
    // Arriving on /#talk is as strong an intent signal as the site gets.
    warm();
    setPhase("ready");
    refreshStatus();
    setError("");
    if (!navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions
      .query({ name: "microphone" })
      .then(function (status) {
        // Only if the visitor is still sitting on the ready screen.
        if (status.state === "granted" && state.phase === "ready") connect();
      })
      .catch(function () {
        // Safari has no "microphone" permission descriptor. Keep the button.
      });
  }

  function open(opts) {
    lastFocus = document.activeElement;
    overlay.dataset.open = "true";
    document.body.classList.add("va-open");
    document.addEventListener("keydown", onKeydown);
    startRendering();
    closeBtn.focus();
    // A click handler passes its event here, which has no `deferred`.
    if (opts && opts.deferred === true) startWhenAllowed();
    else connect();
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

    // Drop the #talk marker once the call is over, so reloading or coming back
    // through history lands on the page rather than reopening the call.
    if (window.location.hash.toLowerCase() === "#talk" && window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }

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
    var cancelled = state.phase === "waking";
    teardown("Call ended");
    if (cancelled) {
      // Nothing ever connected, so "Call ended" would misdescribe what the
      // visitor just did — they gave up on one that never started.
      setStatus("Call cancelled");
      retryBtn.textContent = "Try again";
    }
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
    var dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    miniCanvas.width = Math.round(rect.width * dpr);
    miniCanvas.height = Math.round(rect.height * dpr);
    miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    miniSize = rect.width;
    return miniSize;
  }

  /* Painted on every frame, deliberately.

     Pausing this during a scroll and rate-limiting it were both tried and
     both reverted. The pause left an empty circle for the whole time you
     were scrolling towards the button, which is exactly when you first see
     it; the rate limit drifted off requestAnimationFrame's cadence and made
     the drift stutter. What actually cost anything here was the backing
     store, and that is handled by MAX_DPR. */
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
    fab.addEventListener(evt, function () {
      miniHover = 1;
      // The strongest signal on the page: a click is usually what happens
      // next, so the boot gets a head start of a second or two for free.
      warm();
    });
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
  var lastTransform = "";
  // The button's own measurements only change when the window does, but
  // reading them inside the scroll handler forced a layout on every frame.
  var metrics = null;

  function measureFab() {
    var w = fab.offsetWidth;
    var h = fab.offsetHeight;
    if (!w || !h) return null;
    var orbW = orbWrap.offsetWidth || 1;
    metrics = {
      w: w,
      h: h,
      dockScale: DOCK_DIAMETER / orbW,
      ocx: orbWrap.offsetLeft + orbW / 2,
      ocy: orbWrap.offsetTop + orbWrap.offsetHeight / 2,
    };
    return metrics;
  }

  /* Which coordinate space the button is positioned in.

     While it sits in its slot the answer is the document: the slot scrolls,
     and an absolutely positioned button scrolls with it on the compositor,
     in perfect step and without a line of script running. Writing a fixed
     element's transform from a scroll handler cannot do that — the scroll
     moves on the compositor thread and the transform on the main thread, so
     the button always lags the page by however long the frame took.

     Docked in the corner it is the viewport, where it should not move at
     all. */
  var inDocSpace = false;

  function placementFor(next, vw, vh, m, r) {
    if (next === "docked") {
      // Position the circle, not the whole button: the label is invisible
      // when docked, and measuring the box would leave its empty space
      // between the circle and the corner.
      var gap = vw < 560 ? 18 : 24;
      // Rendered orb centre = buttonCentre + (orbCentre - buttonCentre) * scale
      return {
        doc: false,
        x: vw - gap - DOCK_DIAMETER / 2 - m.w / 2 - (m.ocx - m.w / 2) * m.dockScale,
        y: vh - gap - DOCK_DIAMETER / 2 - m.h / 2 - (m.ocy - m.h / 2) * m.dockScale,
        s: m.dockScale,
      };
    }
    // Document coordinates do not change as the page scrolls, so this write
    // happens once on arrival and never again while you keep scrolling.
    return {
      doc: true,
      x: r.left + window.pageXOffset + r.width / 2 - m.w / 2,
      y: r.top + window.pageYOffset + r.height / 2 - m.h / 2,
      s: 1,
    };
  }

  function writePlacement(p) {
    var t =
      "translate(" + Math.round(p.x) + "px," + Math.round(p.y) + "px) scale(" +
      Number(p.s).toFixed(4) + ")";
    if (p.doc !== inDocSpace) {
      inDocSpace = p.doc;
      fab.classList.toggle("va-fab--abs", p.doc);
    }
    if (t !== lastTransform) {
      lastTransform = t;
      fab.style.transform = t;
    }
  }

  // Changing space moves the origin out from under the button. Restate where
  // it already is in the new space and flush that, so the travel animates
  // from where the eye last saw it rather than jumping first.
  function bridgeSpace(p) {
    if (p.doc === inDocSpace) return;
    var m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(lastTransform);
    if (!m) return;
    var sx = window.pageXOffset;
    var sy = window.pageYOffset;
    var x = parseFloat(m[1]);
    var y = parseFloat(m[2]);
    fab.classList.remove("va-fab--moving");
    writePlacement({
      doc: p.doc,
      x: p.doc ? x + sx : x - sx,
      y: p.doc ? y + sy : y - sy,
      s: parseFloat(m[3]),
    });
    // Force the bridged position to take effect before the animated one.
    void fab.offsetWidth;
  }

  function placeFab() {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var m = metrics || measureFab();
    if (!m) return;

    var r = null;
    var next;
    if (!anchor) {
      // A page with no slot still gets the button, in the corner. Returning
      // here instead left the launcher parked at its initial -9999px
      // transform: invisible, but still focusable, still opening a modal that
      // asks for a microphone, and still repainting its canvas every frame.
      next = "docked";
    } else {
      r = anchor.getBoundingClientRect();
      if (r.top > vh * 0.94) next = "hidden";
      else if (r.bottom < vh * 0.18) next = "docked";
      else next = "anchored";
    }

    var p = placementFor(next, vw, vh, m, r);

    if (next !== travelState) {
      var wasHidden = travelState === null || travelState === "hidden";
      var firstPlacement = travelState === null;
      travelState = next;
      // The button has scrolled into view, so a call is now one click away
      // from anywhere on the page. Not on the first placement, which is a
      // page load rather than anybody doing anything.
      if (!firstPlacement && next !== "hidden") warm();
      fab.classList.toggle("va-fab--hidden", next === "hidden");
      fab.classList.toggle("va-fab--docked", next === "docked");
      bridgeSpace(p);
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

    // In either space this is the same string every frame while the state
    // holds, so a steady scroll writes nothing at all.
    writePlacement(p);
  }

  /* Once the slot is well off screen the button is simply docked, and where
     it sits depends on the viewport rather than the scroll. On a page this
     long that is most of the scroll, so stop tracking it: no rAF, no read,
     no work at all until the slot comes back within reach. */
  var nearSlot = true;

  if (anchor && typeof IntersectionObserver === "function") {
    new IntersectionObserver(
      function (entries) {
        var entry = entries[entries.length - 1];
        nearSlot = entry.isIntersecting;
        // Settle the state on the way past, so leaving the zone leaves the
        // button in the right place rather than wherever it last was.
        placeFab();
      },
      { rootMargin: "150% 0px 150% 0px" },
    ).observe(anchor);
  }

  function scheduleFab() {
    if (!nearSlot || queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      placeFab();
    });
  }

  window.addEventListener("scroll", scheduleFab, { passive: true });
  window.addEventListener("resize", function () {
    // Everything cached above is viewport-dependent, and the docked corner
    // moves with the viewport whether or not the slot is in reach.
    metrics = null;
    miniSize = 0;
    placeFab();
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(scheduleFab);
  }
  placeFab();

  /* Deep link: /#talk opens the call straight away, so the agent can be shared
     as a link rather than "go to my site and scroll down".

     Browsers gate the microphone behind a user gesture, and a page load is not
     one. Where that bites — Safari, or anyone who has not granted the mic here
     before — connect() fails with a clear message and the panel offers a
     button, which is a gesture, so the second attempt works. Chrome and any
     returning visitor connect immediately. */

  function wantsDeepLink() {
    if (window.location.hash.toLowerCase() === "#talk") return true;
    return /(^|[?&])talk(=|&|$)/i.test(window.location.search);
  }

  if (wantsDeepLink()) {
    open({ deferred: true });
  }

  /* Someone who has scrolled or moved a pointer, and whose tab is still
     visible a few seconds later, is a reader. A crawler and a background tab
     are neither, and waking the agent for those is pure waste. This is a low
     enough bar to catch most real visitors before they reach the button, and
     a high enough one to leave automated traffic out. */
  var engagementNoted = false;

  function noteEngagement() {
    if (engagementNoted) return;
    engagementNoted = true;
    setTimeout(function () {
      if (document.visibilityState === "visible") warm();
    }, 10000);
  }

  ["pointermove", "touchstart", "keydown", "scroll"].forEach(function (evt) {
    window.addEventListener(evt, noteEngagement, { passive: true, once: true });
  });

  document.querySelectorAll("[data-va-open]").forEach(function (el) {
    ["pointerenter", "focus"].forEach(function (evt) {
      el.addEventListener(evt, warm);
    });
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
