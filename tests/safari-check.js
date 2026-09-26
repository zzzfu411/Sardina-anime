const video = document.querySelector('#video');
const canvas = document.querySelector('#canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
const status = document.querySelector('#status');
const results = [];
let sample;
const frame = (_time, metadata) => {
  if (sample) sample.frames = metadata.presentedFrames;
  video.requestVideoFrameCallback?.(frame);
};
video.requestVideoFrameCallback?.(frame);
const capture = () => {
  if (!sample) return;
  sample.time = video.currentTime;
  sample.width = video.videoWidth;
  sample.height = video.videoHeight;
  sample.frames = Math.max(
    sample.frames ?? 0,
    video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount ?? 0,
  );
  sample.paused = video.paused;
  sample.readyState = video.readyState;
  sample.visibility = document.visibilityState;
  if (video.readyState >= 2 && video.videoWidth) {
    context.drawImage(video, 0, 0, 48, 27);
    const pixels = context.getImageData(0, 0, 48, 27).data;
    sample.colorPixels = Array.from(
      { length: pixels.length / 4 },
      (_, i) => pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2],
    ).filter((value) => value > 60).length;
  }
  status.textContent = JSON.stringify({ userAgent: navigator.userAgent, results, current: sample }, null, 2);
};
setInterval(capture, 300);
document.querySelector('#start').onclick = async () => {
  document.querySelector('#start').disabled = true;
  const selected = new URLSearchParams(location.search).get('format');
  for (const lineId of selected ? [selected] : ['mp4', 'hls']) {
    sample = { format: lineId, ok: false };
    const result = await fetch('/api/v1/playbacks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: 'fixture', animeId: 'one', lineId, episodeId: '1' }),
    }).then((r) => r.json());
    video.muted = true;
    video.src = result.url;
    try {
      await video.play();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Playback deadline')), 45000);
        video.onended = () => {
          clearTimeout(timer);
          resolve();
        };
        video.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Media error ' + video.error?.code));
        };
      });
      capture();
      sample.ok = sample.frames > 100 && sample.colorPixels > 100 && video.ended;
    } catch (error) {
      sample.error = String(error);
      capture();
    }
    results.push({ ...sample });
    await fetch('/api/v1/playbacks/' + result.sessionId, { method: 'DELETE' });
  }
  sample = undefined;
  const report = { checkedAt: new Date().toISOString(), userAgent: navigator.userAgent, results };
  status.textContent = JSON.stringify(report, null, 2);
  await fetch('/api/v1/test/safari-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
  });
};
