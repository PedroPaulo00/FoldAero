// Gera "Imagens de Exemplo" no estilo Frutiger Aero, desenhadas em canvas (sem arquivos externos).
const Samples = (() => {
  const W = 1080, H = 1440;

  function canvas() {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return [c, c.getContext('2d')];
  }

  function lin(ctx, x0, y0, x1, y1, stops) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([o, c]) => g.addColorStop(o, c));
    return g;
  }

  function rad(ctx, x, y, r, stops) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    stops.forEach(([o, c]) => g.addColorStop(o, c));
    return g;
  }

  function cloud(ctx, x, y, s) {
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    [[0, 0, 60], [55, -25, 70], [120, 0, 60], [60, 20, 60]].forEach(([dx, dy, r]) => {
      ctx.beginPath(); ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2); ctx.fill();
    });
  }

  function bubble(ctx, x, y, r, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rad(ctx, x - r * .3, y - r * .3, r * 1.3, [[0, 'rgba(255,255,255,.55)'], [.6, 'rgba(160,230,255,.18)'], [1, 'rgba(255,255,255,.45)']]);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = Math.max(1.5, r * .04); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath(); ctx.ellipse(x - r * .35, y - r * .45, r * .32, r * .16, -.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  const scenes = [
    {
      name: 'Colina Serena', draw(ctx) {
        ctx.fillStyle = lin(ctx, 0, 0, 0, H * .7, [[0, '#1d5fd1'], [.6, '#6fb3f2'], [1, '#cfe9ff']]);
        ctx.fillRect(0, 0, W, H);
        cloud(ctx, 120, 260, 1.4); cloud(ctx, 640, 420, 1.1); cloud(ctx, 380, 620, .8);
        ctx.fillStyle = lin(ctx, 0, H * .55, 0, H, [[0, '#7fd13a'], [.5, '#3c9a19'], [1, '#1f5e0c']]);
        ctx.beginPath(); ctx.moveTo(0, H * .78);
        ctx.bezierCurveTo(W * .3, H * .5, W * .7, H * .52, W, H * .7);
        ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.12)';
        ctx.beginPath(); ctx.ellipse(W * .45, H * .62, W * .3, 40, -.08, 0, Math.PI * 2); ctx.fill();
      }
    },
    {
      name: 'Aurora Boreal', draw(ctx) {
        ctx.fillStyle = lin(ctx, 0, 0, 0, H, [[0, '#020617'], [.6, '#06233a'], [1, '#0a3b3a']]);
        ctx.fillRect(0, 0, W, H);
        for (let i = 0; i < 160; i++) {
          ctx.fillStyle = `rgba(255,255,255,${Math.random() * .8})`;
          ctx.fillRect(Math.random() * W, Math.random() * H * .6, 2, 2);
        }
        ctx.globalCompositeOperation = 'lighter';
        [['rgba(60,255,170,.22)', 0], ['rgba(40,200,255,.18)', 80], ['rgba(160,90,255,.14)', 160]].forEach(([c, off]) => {
          for (let k = 0; k < 18; k++) {
            ctx.strokeStyle = c; ctx.lineWidth = 40 - k * 1.5;
            ctx.beginPath();
            for (let x = -20; x <= W + 20; x += 20) {
              const y = 420 + off + Math.sin(x / 160 + off) * 90 + Math.cos(x / 70) * 20 + k * 6;
              x === -20 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        });
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#01060c';
        ctx.beginPath(); ctx.moveTo(0, H);
        for (let x = 0; x <= W; x += 60) ctx.lineTo(x, H * .82 - Math.abs(Math.sin(x * .013)) * 160 - (x % 120 ? 0 : 40));
        ctx.lineTo(W, H); ctx.fill();
      }
    },
    {
      name: 'Bolhas Aero', draw(ctx) {
        ctx.fillStyle = lin(ctx, 0, 0, W, H, [[0, '#00a6e8'], [.5, '#33c7c0'], [1, '#8be04a']]);
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,.18)';
        ctx.beginPath(); ctx.moveTo(0, H * .55);
        ctx.bezierCurveTo(W * .4, H * .35, W * .6, H * .85, W, H * .6);
        ctx.lineTo(W, H * .7); ctx.bezierCurveTo(W * .6, H * .95, W * .4, H * .45, 0, H * .68); ctx.fill();
        [[260, 380, 170], [760, 300, 110], [620, 820, 220], [210, 1050, 90], [880, 1180, 140], [430, 620, 60], [950, 620, 50]]
          .forEach(([x, y, r]) => bubble(ctx, x, y, r));
      }
    },
    {
      name: 'Pôr do Sol', draw(ctx) {
        ctx.fillStyle = lin(ctx, 0, 0, 0, H * .62, [[0, '#2b1b5a'], [.45, '#e0557a'], [1, '#ffbf5a']]);
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = rad(ctx, W / 2, H * .6, 300, [[0, '#fff6c8'], [.3, '#ffd36b'], [1, 'rgba(255,170,60,0)']]);
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = lin(ctx, 0, H * .62, 0, H, [[0, '#ff9b52'], [.2, '#7a3d74'], [1, '#160e33']]);
        ctx.fillRect(0, H * .62, W, H * .38);
        for (let i = 0; i < 26; i++) {
          ctx.fillStyle = `rgba(255,225,150,${.5 - i * .017})`;
          const w = 260 - i * 8;
          ctx.fillRect(W / 2 - w / 2 + Math.sin(i) * 12, H * .63 + i * 16, w, 5);
        }
      }
    },
    {
      name: 'Orbe de Vidro', draw(ctx) {
        ctx.fillStyle = rad(ctx, W / 2, H / 2, H * .8, [[0, '#123a5e'], [1, '#000']]);
        ctx.fillRect(0, 0, W, H);
        const x = W / 2, y = H / 2, r = 330;
        ctx.fillStyle = rad(ctx, x, y + r * .3, r * 1.1, [[0, '#4fd6ff'], [.55, '#0d6fc1'], [1, '#021a3d']]);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = lin(ctx, 0, y - r, 0, y, [[0, 'rgba(255,255,255,.75)'], [1, 'rgba(255,255,255,0)']]);
        ctx.beginPath(); ctx.ellipse(x, y - r * .45, r * .78, r * .5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(160,230,255,.5)'; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = rad(ctx, x, y + r * 1.15, r, [[0, 'rgba(79,214,255,.35)'], [1, 'rgba(79,214,255,0)']]);
        ctx.fillRect(0, y + r * .6, W, H);
      }
    },
    {
      name: 'Ondas Aqua', draw(ctx) {
        ctx.fillStyle = lin(ctx, 0, 0, 0, H, [[0, '#dff6ff'], [.5, '#4cb8f0'], [1, '#0a4f9e']]);
        ctx.fillRect(0, 0, W, H);
        for (let k = 0; k < 7; k++) {
          ctx.fillStyle = `rgba(255,255,255,${.08 + k * .025})`;
          ctx.beginPath(); ctx.moveTo(0, H);
          for (let x = 0; x <= W; x += 10) {
            ctx.lineTo(x, H * .35 + k * 120 + Math.sin(x / (140 + k * 20) + k) * (50 + k * 6));
          }
          ctx.lineTo(W, H); ctx.fill();
        }
        bubble(ctx, 820, 260, 70, .9); bubble(ctx, 900, 380, 36, .9); bubble(ctx, 180, 200, 50, .9);
      }
    }
  ];

  const toBlob = (c, type = 'image/jpeg') => new Promise((r) => c.toBlob(r, type, .9));

  async function images() {
    const out = [];
    for (const s of scenes) {
      const [c, ctx] = canvas();
      s.draw(ctx);
      out.push(new File([await toBlob(c)], s.name + '.jpg', { type: 'image/jpeg' }));
    }
    return out;
  }

  // Vídeo curto de bolhas subindo, gravado do canvas (quando o navegador suporta MediaRecorder)
  async function video(seconds = 4) {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      .find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return null;
    const c = document.createElement('canvas');
    c.width = 540; c.height = 720;
    const ctx = c.getContext('2d');
    const bubbles = Array.from({ length: 22 }, () => ({
      x: Math.random() * 540, y: 720 + Math.random() * 720, r: 12 + Math.random() * 50, v: 1.5 + Math.random() * 3
    }));
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start();
    const t0 = performance.now();
    await new Promise((resolve) => {
      (function frame() {
        ctx.fillStyle = lin(ctx, 0, 0, 0, 720, [[0, '#00a6e8'], [1, '#0a4f9e']]);
        ctx.fillRect(0, 0, 540, 720);
        bubbles.forEach((b) => {
          b.y -= b.v; if (b.y < -b.r) b.y = 720 + b.r;
          bubble(ctx, b.x + Math.sin(b.y / 60) * 10, b.y, b.r);
        });
        // setTimeout em vez de requestAnimationFrame: continua gravando mesmo com a aba em segundo plano
        if (performance.now() - t0 < seconds * 1000) setTimeout(frame, 33); else resolve();
      })();
    });
    rec.stop();
    await done;
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    return new File(chunks, 'Bolhas em Movimento.' + ext, { type: mime.split(';')[0] });
  }

  return { images, video };
})();
