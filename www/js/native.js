// Ponte com o app nativo (Android/iOS via Capacitor + plugin DreamMedia). No navegador fica null.
window.NativeMedia = (() => {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;

  const plugin = cap.registerPlugin('DreamMedia');
  const appPlugin = cap.registerPlugin('App');
  const android = cap.getPlatform() === 'android';

  // Nomes das pastas do sistema no estilo do app
  const ALBUMS = {
    Camera: 'Câmera', DCIM: 'Câmera', '100ANDRO': 'Câmera',
    Download: 'Downloads', Downloads: 'Downloads',
    Screenshots: 'Screenshots', 'Capturas de tela': 'Screenshots',
    'WhatsApp Images': 'WhatsApp', 'WhatsApp Video': 'WhatsApp', 'WhatsApp Animated Gifs': 'WhatsApp'
  };
  const HEIC = /image\/hei[cf]/i;
  const THUMB_BATCH = 40;

  // iOS: arquivos exportados pelo plugin (Android serve tudo por URL direta)
  const thumbs = new Map();
  const fulls = new Map();
  const fullJobs = new Map();
  let info = { systemDeleteConfirm: true };

  // Sem data EXIF (arquivo copiado/baixado): tenta a data do nome, ex. IMG_20240815_150000.jpg
  function nameDate(name) {
    const m = /(?:^|\D)(20\d{2}|19\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_ T.]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2}))?/.exec(name || '');
    if (!m) return 0;
    const [, y, mo, d, h = '12', mi = '0', s = '0'] = m;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return 0;
    const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
    return isNaN(t) || t > Date.now() + 86400000 ? 0 : t;
  }

  function toItem(r) {
    return {
      id: 'd:' + r.id,
      nid: r.id,
      src: 'device',
      type: r.type,
      mime: r.mime || '',
      name: r.name || '',
      date: r.taken > 0 || !android ? r.date || 0 : nameDate(r.name) || r.date || 0,
      mod: r.mod || 0,
      album: ALBUMS[r.album] || r.album || 'Câmera',
      duration: r.duration || null,
      favorite: false,
      deletedAt: null
    };
  }

  // Busca miniaturas em lotes e avisa a cada lote pronto (só iOS)
  async function loadThumbs(items, onBatch) {
    const need = items.filter((i) => !thumbs.has(i.id));
    for (let k = 0; k < need.length; k += THUMB_BATCH) {
      const batch = need.slice(k, k + THUMB_BATCH);
      try {
        const res = await plugin.thumbnails({ ids: batch.map((i) => i.nid), size: 384 });
        batch.forEach((i) => {
          const p = res.thumbs && res.thumbs[i.nid];
          if (p) thumbs.set(i.id, cap.convertFileSrc(p));
        });
        onBatch(batch);
      } catch (e) { /* ignora lote com erro */ }
    }
  }

  function loadFull(item) {
    if (fulls.has(item.id)) return Promise.resolve(fulls.get(item.id));
    if (!fullJobs.has(item.id)) {
      fullJobs.set(item.id, plugin.full({ id: item.nid }).then((r) => {
        if (r.name && !item.alias) item.name = r.name;
        const url = cap.convertFileSrc(r.path);
        fulls.set(item.id, url);
        return url;
      }).finally(() => fullJobs.delete(item.id)));
    }
    return fullJobs.get(item.id);
  }

  return {
    android,
    async: !android,
    async init() {
      try { info = await plugin.info(); } catch (e) { /* mantém padrão */ }
    },
    get systemConfirm() { return !!info.systemDeleteConfirm; },
    // iOS não renomeia arquivos da biblioteca de Fotos: o app guarda um apelido
    get canRename() { return !!info.canRename; },
    async status() { return (await plugin.checkAccess()).status; },
    async request() { return (await plugin.requestAccess()).status; },
    openSettings: () => plugin.openSettings(),
    // limit > 0: só os mais recentes (abre a primeira tela rápido); complete=false nesse caso
    async list(limit = 0) {
      const r = await plugin.list({ limit });
      return { items: (r.items || []).map(toItem), complete: r.complete !== false };
    },
    play: (i) => plugin.playVideo({ id: i.nid, title: i.name }),
    async rename(i, name) {
      const r = await plugin.rename({ id: i.nid, type: i.type, name });
      return r.renamed ? r.name : null;
    },
    async save(base64, name, mime, near) {
      return plugin.save({ data: base64, name, mime, near: near ? near.nid : undefined });
    },
    thumbUrl(i, size) {
      return android ? `/_dv_thumb/${i.type}/${i.nid}?m=${i.mod}${size ? `&s=${size}` : ''}` : thumbs.get(i.id) || null;
    },
    fullUrl(i) {
      if (android) return `/_dv_media/${i.type}/${i.nid}` + (HEIC.test(i.mime) ? `?jpeg=1&m=${i.mod}` : '');
      return fulls.get(i.id) || null;
    },
    loadThumbs,
    loadFull,
    async remove(items) {
      const r = await plugin.delete({ items: items.map((i) => ({ id: i.nid, type: i.type })) });
      return !!r.deleted;
    },
    onBack(fn) { appPlugin.addListener('backButton', fn); },
    exit() { appPlugin.exitApp(); }
  };
})();
