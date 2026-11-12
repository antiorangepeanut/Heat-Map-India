// png-capture.js: "Download PNG" via browser tab capture (free, no extra APIs).
(function () {
  function ensureButton() {
    let b = document.getElementById('dlPng');
    if (b) return b;
    b = document.createElement('button');
    b.id = 'dlPng'; b.type = 'button'; b.textContent = '🖼️ Download PNG';
    const lg = document.getElementById('legend');
    if (lg && lg.parentNode) {
      b.style.cssText = 'width:100%;margin-top:8px;font-size:12px';
      lg.parentNode.insertBefore(b, lg.nextSibling);
    } else {
      b.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;padding:8px 12px';
      document.body.appendChild(b);
    }
    return b;
  }

  async function capture() {
    const btn = ensureButton(), label = btn.textContent;
    const md = navigator.mediaDevices;
    if (!md || !md.getDisplayMedia) { alert('Your browser does not support tab capture. Use desktop Chrome, Edge or Firefox.'); return; }
    if (!window.isSecureContext) { alert('Tab capture only works on https:// pages (or localhost).'); return; }

    let stream;
    try {
      try { stream = await md.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true }); }
      catch (e1) {
        if (e1 && e1.name === 'NotAllowedError') throw e1;
        stream = await md.getDisplayMedia({ video: true, audio: false });
      }
    } catch (e) {
      alert(e && e.name === 'NotAllowedError'
        ? 'Capture was cancelled or blocked. Click Download PNG again and choose this tab, then Share.'
        : 'Could not start capture: ' + ((e && e.message) || e));
      return;
    }

    btn.disabled = true;
    try {
      const track = stream.getVideoTracks()[0];
      const surface = track && track.getSettings ? track.getSettings().displaySurface : 'browser';
      const video = document.createElement('video');
      video.srcObject = stream; video.muted = true; video.playsInline = true;
      await video.play();

      btn.style.visibility = 'hidden';                 // keep the button out of the picture
      await new Promise(r => setTimeout(r, 500));      // let a clean frame arrive
      if (video.requestVideoFrameCallback) {
        await new Promise(r => { video.requestVideoFrameCallback(() => r()); setTimeout(r, 1000); });
      }

      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) throw new Error('No video frame received.');
      const out = document.createElement('canvas');
      const ctx = out.getContext('2d');
      const mapEl = document.getElementById('map');

      if (surface === 'browser' && mapEl) {
        const r = mapEl.getBoundingClientRect();
        const sx = vw / window.innerWidth, sy = vh / window.innerHeight;
        out.width = Math.round(r.width * sx); out.height = Math.round(r.height * sy);
        ctx.drawImage(video, r.left * sx, r.top * sy, r.width * sx, r.height * sy, 0, 0, out.width, out.height);
      } else {
        out.width = vw; out.height = vh; ctx.drawImage(video, 0, 0);
        alert('You shared a window or screen instead of this browser tab, so the full capture was saved without cropping. Next time pick the "Chrome Tab" / "This tab" option.');
      }

      const blob = await new Promise(res => out.toBlob(res, 'image/png'));
      if (!blob) throw new Error('Could not create the image.');
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'heatmap_' + new Date().toISOString().slice(0, 10) + '.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      alert('PNG export failed: ' + ((e && e.message) || e));
    } finally {
      stream.getTracks().forEach(t => t.stop());
      btn.style.visibility = ''; btn.disabled = false; btn.textContent = label;
    }
  }

  // Capture-phase listener: wins over any older click handler on the button.
  document.addEventListener('click', e => {
    const t = e.target && e.target.closest ? e.target.closest('#dlPng') : null;
    if (!t) return;
    e.preventDefault(); e.stopImmediatePropagation();
    capture();
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureButton);
  else ensureButton();
})();
