/* 카메라 바코드 인식: 크롬의 BarcodeDetector를 쓰고, 없으면 ZXing으로 대신한다 */
(function () {
  'use strict';
  const FORMATS = ['code_128', 'code_39', 'ean_13', 'qr_code'];

  async function makeDetector() {
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const fm = FORMATS.filter((f) => supported.includes(f));
        if (fm.length) {
          const d = new window.BarcodeDetector({ formats: fm });
          return { name: 'native', detect: async (src) => { const r = await d.detect(src); return r[0] ? r[0].rawValue : null; } };
        }
      } catch (e) {}
    }
    if (window.ZXing) {
      const Z = window.ZXing;
      const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.QR_CODE]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      const reader = new Z.MultiFormatReader();
      reader.setHints(hints);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      /* 바코드가 화면에서 크거나 작을 때 모두 잡히도록 프레임마다 크기를 바꿔 가며 읽는다 */
      const widths = [960, 640, 420];
      let turn = 0;
      return {
        name: 'zxing',
        detect: async (video) => {
          const w = video.videoWidth, h = video.videoHeight;
          if (!w || !h) return null;
          const scale = Math.min(1, widths[turn++ % widths.length] / w);
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          try {
            const src = new Z.HTMLCanvasElementLuminanceSource(canvas);
            const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(src));
            return reader.decode(bmp).getText();
          } catch (e) { return null; }
        }
      };
    }
    return null;
  }

  /* start(video, onCode, {facing}) -> stop() */
  async function start(video, onCode, opts) {
    opts = opts || {};
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('이 브라우저에서는 카메라를 쓸 수 없음 (HTTPS 주소에서만 가능)');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: opts.facing || 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    let det;
    try {
      video.srcObject = stream;
      video.setAttribute('playsinline', '');
      video.muted = true;
      await video.play();
      det = await makeDetector();
      if (!det) throw new Error('바코드 인식기를 불러오지 못함');
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      throw e;
    }

    let alive = true, busy = false, last = '', lastAt = 0;
    const timer = setInterval(async () => {
      if (!alive || busy || video.readyState < 2) return;
      busy = true;
      try {
        const code = await det.detect(video);
        const now = Date.now();
        if (code && (code !== last || now - lastAt > 4000)) {
          last = code; lastAt = now;
          onCode(String(code).trim());
        }
      } catch (e) {}
      busy = false;
    }, 250);

    return function stop() {
      alive = false;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }

  window.Scanner = { start };
})();
