/* barcode.js — continuous camera scanning, fully offline (no CDN, no network).
   Two modes:
   - "barcode" (default): detection restricted to a slim horizontal band, not the
     whole frame, so a barcode has to actually be centered in that band to
     register — cuts down on grabbing the wrong adjacent barcode on a shelf.
   - "qr": detection uses a large centered square area (QR codes are square,
     not a thin strip) and only looks for qr_code, used for scanning rack
     labels. */
const Scanner = (() => {
  let stream = null;
  let detector = null;
  let rafId = null;
  let gen = 0; // bumped on every start(), so a loop left over from before a stop() can never keep running beside the new one
  let videoEl = null;
  let cropCanvas = null;
  let cropCtx = null;
  let onDetect = null;
  let lastCode = null;
  let lastTime = 0;
  let lastAttempt = 0;
  const DETECT_INTERVAL_MS = 120; // throttle detection instead of running every animation frame
  let region = null; // {mode, widthRatio, heightRatio}
  const RESCAN_COOLDOWN_MS = 1200;
  // A code only actually triggers a scan once it's been seen in this many
  // CONSECUTIVE detection attempts in a row — filters out the accidental,
  // one-frame catch of a barcode passing through the guide band while
  // repositioning an item or the phone (common complaint: "it scans
  // anything that passes in front of it"), without requiring a deliberate
  // tap-to-scan step that would slow down every real scan. At the current
  // ~120ms detection interval this adds roughly one more cycle (~120ms) of
  // latency to a genuine scan — well under what it takes to physically
  // hold an item still — while a barcode only glimpsed for a single frame
  // never accumulates enough consecutive hits to fire.
  const CONFIRM_FRAMES = 2;
  let pendingCode = null;
  let pendingCount = 0;

  const MODES = {
    barcode: {
      formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "codabar", "itf"],
      widthRatio: 0.92, // matches .scan-band: left 4% / right 4%
      heightRatio: 0.22,
    },
    qr: {
      formats: ["qr_code"],
      widthRatio: 0.82, // large centered square — QR codes need width, not a thin strip
      heightRatio: 0.82,
    },
  };

  function supported() {
    return "BarcodeDetector" in window;
  }

  // ONE shared AudioContext, created and unlocked early and then kept alive.
  // The old code built a brand-new AudioContext inside every beep. A fresh
  // context starts "suspended" (browser autoplay rules — the scan isn't a tap)
  // and its audio hardware needs a moment to wake up, so the FIRST beep came out
  // late, clipped or silent, and only later ones sounded normal.
  let audioCtx = null;
  function getCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC({ latencyHint: "interactive" });
    }
    return audioCtx;
  }
  // Call from a real user tap (and when the scanner starts): creates/resumes the
  // context and plays one silent sample so the output device is already awake
  // by the time the first real scan happens.
  function unlockAudio() {
    try {
      const ctx = getCtx();
      if (!ctx) return;
      if (ctx.state !== "running") ctx.resume().catch(() => {});
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) { /* audio not available */ }
  }
  ["pointerdown", "touchstart", "click", "keydown"].forEach((ev) =>
    window.addEventListener(ev, unlockAudio, { capture: true, passive: true })
  );

  function beep() {
    try {
      const ctx = getCtx();
      if (!ctx) return;
      const play = () => {
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = 1500;
        // Short fade in/out so it never clicks or gets clipped, same loudness as before.
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.15, t + 0.008);
        gain.gain.setValueAtTime(0.15, t + 0.1);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.125);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.13);
      };
      if (ctx.state === "running") play();
      else ctx.resume().then(play).catch(play); // if it was suspended, wait until it is really running
    } catch (e) {
      /* audio not available, fail silently */
    }
  }

  async function start(video, callback, opts = {}) {
    unlockAudio(); // warm up the beep BEFORE the first scan, not during it
    videoEl = video;
    onDetect = callback;
    lastCode = null;
    lastTime = 0;
    lastAttempt = 0;
    pendingCode = null;
    pendingCount = 0;

    if (!supported()) {
      throw new Error("This browser doesn't support live scanning. Use manual entry, or open this app in a recent Chrome/Edge browser.");
    }

    const modeName = opts.mode === "qr" ? "qr" : "barcode";
    region = MODES[modeName];

    detector = new BarcodeDetector({ formats: region.formats });

    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();

    cropCanvas = document.createElement("canvas");
    cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });

    gen++;
    const g = gen;
    loop(g);
  }

  async function loop(g) {
    if (!stream || g !== gen) return;
    const now = Date.now();
    if (now - lastAttempt < DETECT_INTERVAL_MS) {
      rafId = requestAnimationFrame(() => loop(g));
      return;
    }
    lastAttempt = now;
    try {
      const vw = videoEl.videoWidth,
        vh = videoEl.videoHeight;
      if (vw && vh) {
        const cropW = Math.round(vw * region.widthRatio);
        const cropH = Math.round(vh * region.heightRatio);
        const cropX = Math.round((vw - cropW) / 2);
        const cropY = Math.round((vh - cropH) / 2);
        if (cropCanvas.width !== cropW || cropCanvas.height !== cropH) {
          cropCanvas.width = cropW;
          cropCanvas.height = cropH;
        }
        cropCtx.drawImage(videoEl, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

        const codes = await detector.detect(cropCanvas);
        if (!stream || g !== gen) return; // stop() was called while this detection was in flight — never report a code after stopping
        if (codes.length > 0) {
          const value = codes[0].rawValue;
          if (value === pendingCode) pendingCount++;
          else { pendingCode = value; pendingCount = 1; }

          if (pendingCount >= CONFIRM_FRAMES) {
            const detectedAt = Date.now();
            if (value !== lastCode || detectedAt - lastTime > RESCAN_COOLDOWN_MS) {
              lastCode = value;
              lastTime = detectedAt;
              beep();
              if (onDetect) onDetect(value);
            }
            // Reset the streak either way, so a code held in view doesn't
            // need to keep re-crossing the confirm threshold to re-trigger
            // once its cooldown passes, but also doesn't just spam-fire
            // every single frame it stays visible.
            pendingCode = null;
            pendingCount = 0;
          }
        } else {
          // Nothing detected this frame — a genuine scan attempt keeps the
          // barcode in view across consecutive frames, so losing it means
          // whatever was seen before (if anything) was momentary.
          pendingCode = null;
          pendingCount = 0;
        }
      }
    } catch (e) {
      // detection hiccup on this frame, ignore and keep going
    }
    rafId = requestAnimationFrame(() => loop(g));
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
  }

  return { supported, start, stop, beep, MODES };
})();
