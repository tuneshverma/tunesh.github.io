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

  function drawRing(cx, cy, rx, ry, tilt, color, alpha) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, tilt, 0, TAU);
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawCore(cx, cy, radius, color, level, data) {
    var points = 80;
    var still = reduceMotion.matches;
    var wobble = still ? 0 : 0.17 * level;

    ctx.beginPath();
    for (var i = 0; i <= points; i++) {
      var angle = (i / points) * TAU;
      var bin = 0;
      if (data && data.length && !still) {
        bin = data[Math.floor((i / points) * data.length * 0.45)] / 255;
      }
      var r = radius * (1 + bin * wobble);
      var x = cx + Math.cos(angle) * r;
      var y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    // Highlight sits up and to the left of centre so the core reads as a lit
    // sphere. A centred gradient flattens it into a patch of fog.
    var gradient = ctx.createRadialGradient(
      cx - radius * 0.3,
      cy - radius * 0.34,
      radius * 0.04,
      cx,
      cy,
      radius * 1.04,
    );
    gradient.addColorStop(0, rgba(lift(color, 0.5), 1));
    gradient.addColorStop(0.4, rgba(color, 0.82));
    gradient.addColorStop(0.82, rgba(color, 0.34));
    gradient.addColorStop(1, rgba(color, 0.1));
    ctx.fillStyle = gradient;
    ctx.fill();

    // A hairline rim gives the sphere an edge, echoing the 1px borders the
    // rest of the site uses.
    ctx.strokeStyle = rgba(lift(color, 0.25), 0.5);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function frame(now) {
    var size = canvas.clientWidth ? canvas.width / (window.devicePixelRatio || 1) : 0;
    if (!size) {
      rafId = requestAnimationFrame(frame);
      return;
    }

    ctx.clearRect(0, 0, size, size);

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

    var cx = size / 2;
    var cy = size / 2;
    var base = size * 0.19;
    var radius = base * (1 + state.level * 0.26);
    var spin = reduceMotion.matches ? 0 : now / 9000;

    ctx.save();

    // Ambient glow, strongest while the agent is talking.
    var glow = ctx.createRadialGradient(cx, cy, radius * 0.6, cx, cy, size * 0.5);
    glow.addColorStop(0, rgba(state.color, 0.16 + state.level * 0.2));
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // Rings frame the core rather than competing with it, so they stay just
    // outside the sphere and fade back as it grows.
    var ringR = size * 0.36;
    var ringFade = 1 - state.level * 0.3;
    drawRing(cx, cy, ringR, ringR * 0.40, RING_A + spin, state.color, 0.3 * ringFade);
    drawRing(cx, cy, ringR * 0.78, ringR * 0.3, RING_B - spin * 1.4, state.color, 0.2 * ringFade);

    drawCore(cx, cy, radius, state.color, state.level, source ? source.data : null);

    ctx.restore();
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
    if (lastFocus && lastFocus.focus) lastFocus.focus();
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
