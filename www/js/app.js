// FoldAero — lógica principal: roteamento, grade, álbuns, pastas, favoritos, lixeira e visualizador.
(() => {
  'use strict';

  const APP_VERSION = '1.4';
  const GITHUB_URL = 'https://github.com/PedroPaulo00';
  const TRASH_DAYS = 30;
  const CHUNK = 72;
  const FIRST_PAGE = 300; // mídias mostradas antes de a galeria inteira terminar de carregar
  const DAY = 86400000;
  const ALBUM_ORDER = ['Câmera', 'Screenshots', 'Downloads', 'WhatsApp', 'Imagens de Exemplo'];
  const TABS = { geral: 'Geral', albuns: 'Álbuns', favoritos: 'Favoritos', lixeira: 'Lixeira' };
  const NM = window.NativeMedia; // null no navegador
  const IS_NATIVE = !!NM;

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, html = '') => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    if (html) n.innerHTML = html;
    return n;
  };
  const icon = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* armazenamento indisponível */ } }
  };

  const ui = {
    content: $('#content'),
    commandbar: $('#commandbar'),
    statusbar: $('#statusbar'),
    breadcrumb: $('#breadcrumb'),
    back: $('#btn-back'),
    start: $('#btn-start'),
    startMenu: $('#start-menu'),
    viewer: $('#viewer'),
    stage: $('#v-stage'),
    vbar: $('#v-bar'),
    modal: $('#modal'),
    balloon: $('#balloon'),
    fileInput: $('#file-input'),
    folderInput: $('#folder-input')
  };

  const state = {
    items: [],
    index: new Map(),
    meta: new Map(),
    folders: [],
    route: { tab: 'geral', album: null, folder: null },
    selecting: false,
    selected: new Set(),
    pickFor: null, // pasta que está recebendo itens (modo "Adicionar")
    cols: Math.min(6, Math.max(2, +store.get('dv-cols', 4) || 4)),
    rendered: 0,
    observer: null,
    loading: true,
    access: 'granted', // app nativo: granted | limited | prompt | denied
    askedAccess: false,
    forceRoute: false,
    albumColors: (() => { try { return JSON.parse(store.get('dv-album-colors', '{}')) || {}; } catch (e) { return {}; } })(),
    version: 0,
    modalCancel: null
  };

  /* ======================= Utilidades ======================= */

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fmtDate = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtDuration = (s) => {
    if (!s || !isFinite(s)) return '';
    s = Math.round(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const daysLeft = (it) => Math.max(0, Math.ceil((it.deletedAt + TRASH_DAYS * DAY - Date.now()) / DAY));
  const byDate = (a, b) => b.date - a.date;
  const byId = (id) => state.index.get(id);
  const displayName = (it) => it.name || fmtDate(it.date);

  const fmtDay = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtMonth = new Intl.DateTimeFormat('pt-BR', { month: 'long' });

  // Agrupamento: dias no mês atual, meses no ano atual e anos nos anos anteriores
  function grouper() {
    const now = new Date();
    const cy = now.getFullYear(), cm = now.getMonth(), cd = now.getDate();
    const yesterday = new Date(cy, cm, cd - 1);
    return {
      key(t) {
        const d = new Date(t);
        const y = d.getFullYear(), m = d.getMonth();
        if (y > cy || (y === cy && m >= cm)) return `d${y}-${m}-${d.getDate()}`;
        if (y === cy) return `m${m}`;
        return `y${y}`;
      },
      label(key, t) {
        const d = new Date(t);
        if (key[0] === 'y') return String(d.getFullYear());
        if (key[0] === 'm') return capitalize(fmtMonth.format(d));
        if (d.getFullYear() === cy && d.getMonth() === cm && d.getDate() === cd) return 'Hoje';
        if (d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) return 'Ontem';
        return capitalize(fmtDay.format(d));
      }
    };
  }

  function summary(list) {
    const c = { image: 0, gif: 0, video: 0 };
    list.forEach((i) => c[i.type]++);
    const parts = [];
    if (c.image) parts.push(plural(c.image, 'foto', 'fotos'));
    if (c.video) parts.push(plural(c.video, 'vídeo', 'vídeos'));
    if (c.gif) parts.push(plural(c.gif, 'GIF', 'GIFs'));
    return parts.join(', ');
  }

  /* ======================= Dados e caches ======================= */

  // Toda mudança de dados incrementa a versão e invalida as listas memorizadas
  function changed() { state.version++; }

  function setItems(items) {
    state.items = items;
    state.index = new Map(items.map((i) => [i.id, i]));
    changed();
  }

  const memoStore = new Map();
  function memo(name, fn) {
    const m = memoStore.get(name);
    if (m && m.v === state.version) return m.val;
    const val = fn();
    memoStore.set(name, { v: state.version, val });
    return val;
  }

  const active = () => memo('active', () => state.items.filter((i) => !i.deletedAt).sort(byDate));
  const trashed = () => memo('trash', () => state.items.filter((i) => i.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt));
  const folderById = (id) => state.folders.find((f) => f.id === id);
  const folderItems = (f) => memo('f:' + f.id, () => f.items.map(byId).filter((i) => i && !i.deletedAt).sort(byDate));
  const sortedFolders = () => memo('folders', () => [...state.folders].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));

  function albumsList() {
    return memo('albums', () => {
      const map = new Map();
      active().forEach((i) => {
        if (!map.has(i.album)) map.set(i.album, []);
        map.get(i.album).push(i);
      });
      const rank = (n) => { const r = ALBUM_ORDER.indexOf(n); return r < 0 ? 99 : r; };
      return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'pt-BR'));
    });
  }

  function currentList() {
    const { tab, album, folder } = state.route;
    return memo(`list:${tab}:${album || ''}:${folder || ''}`, () => {
      if (tab === 'lixeira') return trashed();
      if (tab === 'favoritos') return active().filter((i) => i.favorite);
      if (folder) { const f = folderById(folder); return f ? folderItems(f) : []; }
      if (album) return active().filter((i) => i.album === album);
      if (tab === 'albuns') return [];
      return active();
    });
  }

  // Salva favorito/lixeira: arquivos importados ficam em "media"; mídias do aparelho em "meta"
  async function persist(list) {
    const local = [], meta = [], clear = [];
    list.forEach((i) => {
      if (i.src !== 'device') local.push(i);
      else if (i.favorite || i.deletedAt || i.alias) {
        meta.push({ id: i.id, favorite: !!i.favorite, deletedAt: i.deletedAt || null, name: i.alias ? i.name : null });
      } else clear.push(i.id);
    });
    meta.forEach((m) => state.meta.set(m.id, m));
    clear.forEach((id) => state.meta.delete(id));
    try {
      await Promise.all([
        local.length && DB.putMany('media', local),
        meta.length && DB.putMany('meta', meta),
        clear.length && DB.remove('meta', clear)
      ]);
    } catch (e) {
      toast('Erro ao salvar', 'Não foi possível gravar a alteração neste dispositivo.', 'i-warning');
    }
  }

  const saveFolders = (list) => DB.putMany('folders', list).catch(() => toast('Erro ao salvar', 'Não foi possível gravar a pasta.', 'i-warning'));

  /* ======================= Fontes de imagem ======================= */

  const urls = new Map();
  function blobUrl(item, kind) {
    const blob = kind === 'thumb' ? (item.thumb || item.blob) : item.blob;
    const key = item.id + (blob === item.thumb ? ':t' : ':f');
    if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
    return urls.get(key);
  }
  function revoke(item) {
    [':t', ':f'].forEach((s) => {
      const u = urls.get(item.id + s);
      if (u) { URL.revokeObjectURL(u); urls.delete(item.id + s); }
    });
  }
  const thumbSrc = (it) => (it.src === 'device' ? NM.thumbUrl(it) : blobUrl(it, 'thumb'));
  const fullSrc = (it) => (it.src === 'device' ? NM.fullUrl(it) : blobUrl(it, 'full'));

  // iOS: miniaturas/GIFs chegam de forma assíncrona; aplica nos blocos já desenhados
  function hydrate(items) {
    if (!NM || !NM.async) return;
    const setSrc = (it, url) => {
      const img = ui.content.querySelector(`.tile[data-id="${CSS.escape(it.id)}"] img`);
      if (img && url && img.getAttribute('src') !== url) img.src = url;
    };
    const missing = items.filter((i) => i.src === 'device' && !NM.thumbUrl(i));
    if (missing.length) NM.loadThumbs(missing, (batch) => batch.forEach((i) => setSrc(i, NM.thumbUrl(i))));
    items.filter((i) => i.type === 'gif' && i.src === 'device' && !NM.fullUrl(i))
      .forEach((i) => NM.loadFull(i).then((url) => setSrc(i, url)).catch(() => {}));
  }

  /* ======================= Importação (navegador) ======================= */

  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp|avi|ogv)$/i;
  const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|heic|heif|avif|svg|tiff?)$/i;

  function typeOf(file) {
    const n = file.name, m = file.type || '';
    if (m === 'image/gif' || /\.gif$/i.test(n)) return 'gif';
    if (m.startsWith('video/') || VIDEO_EXT.test(n)) return 'video';
    if (m.startsWith('image/') || IMAGE_EXT.test(n)) return 'image';
    return null;
  }

  // Simula as pastas do sistema a partir do caminho ou do padrão de nome do arquivo
  function albumFor(file) {
    const rel = file.webkitRelativePath;
    if (rel && rel.includes('/')) {
      const parts = rel.split('/');
      const folder = parts[parts.length - 2];
      if (/^(dcim|camera|câmera|100andro|100apple)$/i.test(folder)) return 'Câmera';
      return folder;
    }
    const n = file.name;
    if (/screenshot|screen_?shot|captura|^scr[_-]/i.test(n)) return 'Screenshots';
    if (/whatsapp|-WA\d+/i.test(n)) return 'WhatsApp';
    if (/^(IMG|VID|PXL|DSC|DSCN|MVIMG|PANO|MOV)[-_]/i.test(n) || /^\d{8}_\d{6}/.test(n)) return 'Câmera';
    return 'Downloads';
  }

  function dateFor(file) {
    const m = file.name.match(/(20\d{2}|19\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_ T.]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2}))?/);
    if (m) {
      const [, y, mo, d, h = '12', mi = '0', s = '0'] = m;
      const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
      if (!isNaN(t) && +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 && t <= Date.now() + DAY) return t;
    }
    return file.lastModified || Date.now();
  }

  const canvasBlob = (c) => new Promise((r) => c.toBlob(r, 'image/jpeg', .82));

  function drawThumb(source, w, h, max = 420) {
    const k = Math.min(1, max / Math.min(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    return canvasBlob(c);
  }

  async function imageThumb(file) {
    if (!window.createImageBitmap || file.size < 250 * 1024) return null;
    try {
      const bmp = await createImageBitmap(file);
      const t = await drawThumb(bmp, bmp.width, bmp.height);
      bmp.close && bmp.close();
      return t;
    } catch (e) {
      return null;
    }
  }

  function videoThumb(file) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      const url = URL.createObjectURL(file);
      let done = false;
      const finish = (thumb) => {
        if (done) return;
        done = true;
        const duration = isFinite(v.duration) ? v.duration : null;
        v.removeAttribute('src'); v.load();
        URL.revokeObjectURL(url);
        resolve({ thumb, duration });
      };
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.onloadeddata = () => {
        v.currentTime = isFinite(v.duration) && v.duration > 1 ? Math.min(1, v.duration / 3) : 0.05;
      };
      v.onseeked = async () => {
        try { finish(await drawThumb(v, v.videoWidth, v.videoHeight)); } catch (e) { finish(null); }
      };
      v.onerror = () => finish(null);
      setTimeout(() => finish(null), 8000);
      v.src = url;
    });
  }

  async function importFiles(fileList, opts = {}) {
    const files = Array.from(fileList).filter((f) => typeOf(f));
    if (!files.length) {
      toast('Nada para importar', 'Nenhuma foto, vídeo ou GIF foi encontrado na seleção.', 'i-warning');
      return;
    }
    const sigs = new Set(state.items.map((i) => i.sig));
    const fresh = files.filter((f) => !sigs.has(`${f.name}|${f.size}|${f.lastModified}`));
    const skipped = files.length - fresh.length;
    toast('Importando…', `Preparando ${plural(fresh.length, 'item', 'itens')}.`, 'i-import', 0);

    const added = [];
    try {
      let batch = [];
      for (let n = 0; n < fresh.length; n++) {
        const f = fresh[n];
        const type = typeOf(f);
        const item = {
          id: uid(),
          src: 'local',
          sig: `${f.name}|${f.size}|${f.lastModified}`,
          name: f.name,
          type,
          mime: f.type,
          album: opts.album || albumFor(f),
          date: opts.dateFn ? opts.dateFn(f, n) : dateFor(f),
          added: Date.now(),
          favorite: false,
          deletedAt: null,
          blob: f,
          thumb: null,
          duration: null
        };
        if (type === 'video') Object.assign(item, await videoThumb(f));
        else if (type === 'image') item.thumb = await imageThumb(f);
        batch.push(item);
        added.push(item);
        if (batch.length >= 20 || n === fresh.length - 1) {
          await DB.putMany('media', batch);
          batch = [];
          toast('Importando…', `${n + 1} de ${fresh.length} itens copiados.`, 'i-import', 0);
        }
      }
    } catch (e) {
      toast('Falha na importação', 'Não foi possível copiar todos os arquivos (talvez falte espaço).', 'i-warning', 5000);
    }
    if (!added.length && !skipped) return;
    setItems([...state.items, ...added]);
    const folder = opts.folder && folderById(opts.folder);
    if (folder && added.length) await addToFolder(folder, added.map((i) => i.id), { quiet: true });
    render({ keepScroll: true });
    const extra = skipped ? ` ${plural(skipped, 'item já existia e foi ignorado', 'itens já existiam e foram ignorados')}.` : '';
    toast('Importação concluída', `${plural(added.length, 'item adicionado', 'itens adicionados')} à galeria.${extra}`, 'i-info');
  }

  async function loadSamples() {
    toast('Gerando imagens de exemplo…', 'Desenhando papéis de parede Aero.', 'i-sample', 0);
    // Carregado só quando pedido: não pesa na abertura do app
    if (!window.Samples) {
      await new Promise((resolve, reject) => {
        document.head.append(el('script', { src: 'js/samples.js', onload: resolve, onerror: reject }));
      });
    }
    const files = await Samples.images();
    try {
      const timeout = new Promise((r) => setTimeout(() => r(null), 10000));
      const v = await Promise.race([Samples.video(), timeout]);
      if (v && v.size) files.push(v);
    } catch (e) { /* sem MediaRecorder: só imagens */ }
    const now = Date.now();
    await importFiles(files, { album: 'Imagens de Exemplo', dateFn: (f, i) => now - i * 9 * DAY - 3600000 });
  }

  /* ======================= Galeria do aparelho (app nativo) ======================= */

  let lastScan = 0, scanning = null;

  // Junta a lista do aparelho com favoritos/lixeira/apelidos salvos pelo app
  function applyDevice(list, complete) {
    const ids = new Set();
    list.forEach((it) => {
      ids.add(it.id);
      const m = state.meta.get(it.id);
      if (m) {
        it.favorite = !!m.favorite;
        it.deletedAt = m.deletedAt || null;
        if (m.name) { it.name = m.name; it.alias = true; }
      }
    });
    // Remove marcações de mídias que não existem mais no aparelho (só com a lista completa)
    if (complete) {
      const stale = [...state.meta.keys()].filter((k) => !ids.has(k));
      if (stale.length) {
        stale.forEach((k) => state.meta.delete(k));
        DB.remove('meta', stale).catch(() => {});
      }
      lastScan = Date.now();
    }
    setItems([...state.items.filter((i) => i.src !== 'device'), ...list]);
  }

  async function loadDevice() {
    applyDevice((await NM.list()).items, true);
  }

  // Ao voltar para o app, procura fotos novas (ex.: tiradas com a câmera)
  function rescan(force = false, quiet = false) {
    if (!IS_NATIVE || scanning || (!force && Date.now() - lastScan < 4000)) return scanning;
    scanning = (async () => {
      const before = state.access;
      try {
        state.access = await NM.status();
        if (state.access === 'granted' || state.access === 'limited') {
          const sig = signature();
          await loadDevice();
          if (sig !== signature() || before !== state.access) render({ keepScroll: true });
        } else if (before !== state.access) {
          setItems(state.items.filter((i) => i.src !== 'device'));
          render();
        }
        if (force && !quiet) toast('Galeria atualizada', `${plural(active().length, 'item', 'itens')} na galeria.`, 'i-info');
      } catch (e) {
        if (force) toast('Falha ao atualizar', 'Não foi possível ler a galeria do aparelho.', 'i-warning');
      } finally {
        scanning = null;
      }
    })();
    return scanning;
  }

  const signature = () => state.items.length + ':' + state.items.reduce((a, i) => (a + (i.mod || 0) + i.date) % 1e12, 0);

  async function requestAccess() {
    try {
      if (state.access === 'denied' && state.askedAccess) {
        await NM.openSettings();
        return;
      }
      state.askedAccess = true;
      state.access = await NM.request();
      if (state.access === 'granted' || state.access === 'limited') {
        state.loading = true;
        render();
        await loadDevice();
        state.loading = false;
      } else {
        toast('Acesso negado', 'Permita o acesso às fotos nas configurações do aparelho.', 'i-warning', 5000);
      }
    } catch (e) {
      toast('Falha ao pedir acesso', 'Tente novamente pelas configurações do aparelho.', 'i-warning');
    }
    state.loading = false;
    render();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') rescan();
  });

  /* ======================= Ações sobre mídias ======================= */

  async function setFavorite(ids, value) {
    const list = ids.map(byId).filter(Boolean);
    list.forEach((i) => (i.favorite = value));
    changed();
    await persist(list);
  }

  async function moveToTrash(ids, { ask = true } = {}) {
    if (!ids.length) return false;
    if (ask) {
      const ok = await confirmBox({
        title: 'Excluir',
        icon: 'i-trash',
        message: ids.length === 1
          ? 'Tem certeza de que deseja mover este arquivo para a Lixeira?'
          : `Tem certeza de que deseja mover estes ${ids.length} itens para a Lixeira?`,
        detail: `Os itens ficam em "Excluídos Recentemente" por ${TRASH_DAYS} dias.`
      });
      if (!ok) return false;
    }
    const now = Date.now();
    const list = ids.map(byId).filter(Boolean);
    list.forEach((i) => (i.deletedAt = now));
    changed();
    await persist(list);
    toast('Movido para a Lixeira', `${plural(list.length, 'item', 'itens')} em Excluídos Recentemente.`, 'i-trash');
    return true;
  }

  async function restore(ids) {
    const list = ids.map(byId).filter(Boolean);
    list.forEach((i) => (i.deletedAt = null));
    changed();
    await persist(list);
    toast('Restaurado', `${plural(list.length, 'item voltou', 'itens voltaram')} para a galeria.`, 'i-restore');
  }

  async function purge(ids, { ask = true } = {}) {
    if (!ids.length) return false;
    const list = ids.map(byId).filter(Boolean);
    const device = list.filter((i) => i.src === 'device');
    // No Android 11+ e no iOS o próprio sistema pede a confirmação da exclusão
    if (ask && !(device.length === list.length && NM && NM.systemConfirm)) {
      const ok = await confirmBox({
        title: 'Excluir permanentemente',
        icon: 'i-warning',
        message: list.length === 1
          ? 'Tem certeza de que deseja excluir este arquivo permanentemente?'
          : `Tem certeza de que deseja excluir estes ${list.length} itens permanentemente?`,
        detail: 'Esta ação não pode ser desfeita.',
        ok: 'Excluir'
      });
      if (!ok) return false;
    }
    if (device.length) {
      try {
        if (!(await NM.remove(device))) return false;
      } catch (e) {
        toast('Não foi possível excluir', 'O sistema não permitiu excluir estes arquivos.', 'i-warning');
        return false;
      }
    }
    const set = new Set(list.map((i) => i.id));
    list.forEach(revoke);
    setItems(state.items.filter((i) => !set.has(i.id)));
    // Limpa referências nas pastas e nos metadados
    const touched = state.folders.filter((f) => f.items.some((id) => set.has(id)));
    touched.forEach((f) => (f.items = f.items.filter((id) => !set.has(id))));
    const localIds = list.filter((i) => i.src !== 'device').map((i) => i.id);
    const metaIds = device.map((i) => i.id);
    metaIds.forEach((id) => state.meta.delete(id));
    await Promise.all([
      localIds.length && DB.remove('media', localIds),
      metaIds.length && DB.remove('meta', metaIds),
      touched.length && saveFolders(touched)
    ]).catch(() => {});
    return true;
  }

  async function purgeExpired() {
    const limit = Date.now() - TRASH_DAYS * DAY;
    const expired = state.items.filter((i) => i.deletedAt && i.deletedAt < limit);
    if (!expired.length) return;
    const local = expired.filter((i) => i.src !== 'device').map((i) => i.id);
    if (local.length) await purge(local, { ask: false });
    // Arquivos do aparelho precisam da confirmação do sistema
    const device = expired.filter((i) => i.src === 'device').map((i) => i.id);
    if (device.length) {
      const ok = await confirmBox({
        title: 'Lixeira',
        icon: 'i-trash-full',
        message: `${plural(device.length, 'item está', 'itens estão')} na Lixeira há mais de ${TRASH_DAYS} dias.`,
        detail: 'Deseja excluí-los permanentemente do aparelho agora?'
      });
      if (ok) await purge(device, { ask: false });
    }
  }

  /* ======================= Pastas do usuário ======================= */

  function validName(name, except) {
    name = (name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!name) return null;
    if (/[\\/:*?"<>|]/.test(name)) {
      toast('Nome inválido', 'O nome não pode conter: \\ / : * ? " < > |', 'i-warning');
      return null;
    }
    if (state.folders.some((f) => f !== except && f.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))) {
      toast('Nome em uso', `Já existe uma pasta chamada "${name}".`, 'i-warning');
      return null;
    }
    return name;
  }

  function suggestName() {
    let n = 'Nova pasta', k = 2;
    while (state.folders.some((f) => f.name === n)) n = `Nova pasta (${k++})`;
    return n;
  }

  async function newFolder() {
    const raw = await promptBox({ title: 'Nova pasta', message: 'Digite o nome da nova pasta:', value: suggestName(), ok: 'Criar' });
    const name = raw == null ? null : validName(raw);
    if (!name) return null;
    const f = { id: uid(), name, created: Date.now(), items: [] };
    state.folders.push(f);
    changed();
    await saveFolders([f]);
    return f;
  }

  async function addToFolder(f, ids, { quiet = false } = {}) {
    const set = new Set(f.items);
    const before = set.size;
    ids.forEach((id) => set.add(id));
    f.items = [...set];
    changed();
    await saveFolders([f]);
    if (!quiet) toast('Adicionado à pasta', `${plural(set.size - before, 'item adicionado', 'itens adicionados')} a "${f.name}".`, 'i-folder');
  }

  async function removeFromFolder(f, ids) {
    const set = new Set(ids);
    f.items = f.items.filter((id) => !set.has(id));
    changed();
    await saveFolders([f]);
    toast('Removido da pasta', `${plural(ids.length, 'item continua', 'itens continuam')} na galeria.`, 'i-folder');
  }

  async function renameFolder(f) {
    const raw = await promptBox({ title: 'Renomear pasta', message: 'Novo nome da pasta:', value: f.name, ok: 'Renomear' });
    const name = raw == null ? null : validName(raw, f);
    if (!name || name === f.name) return;
    f.name = name;
    changed();
    await saveFolders([f]);
    render({ keepScroll: true });
  }

  async function deleteFolder(f) {
    const ok = await confirmBox({
      title: 'Excluir pasta',
      icon: 'i-folder',
      message: `Excluir a pasta "${f.name}"?`,
      detail: 'As fotos e vídeos continuam na galeria. Só a pasta é removida.'
    });
    if (!ok) return;
    state.folders = state.folders.filter((x) => x !== f);
    changed();
    await DB.remove('folders', [f.id]).catch(() => {});
    go('#/albuns');
    toast('Pasta excluída', `"${f.name}" foi removida.`, 'i-folder');
  }

  // Escolhe (ou cria) a pasta de destino para os itens selecionados
  async function chooseFolder() {
    const list = el('div', { class: 'pick-list' });
    const res = dialog({
      title: 'Adicionar à pasta',
      icon: 'i-folder',
      message: 'Escolha a pasta de destino:',
      body: list,
      buttons: [{ label: 'Cancelar', value: null }]
    });
    list.append(el('button', { class: 'pick-item', onclick: () => res.close('new') }, `${icon('i-import')}<span>Nova pasta…</span>`));
    sortedFolders().forEach((f) => {
      list.append(el('button', { class: 'pick-item', onclick: () => res.close(f.id) },
        `${icon('i-folder')}<span>${esc(f.name)}</span><small>${plural(folderItems(f).length, 'item', 'itens')}</small>`));
    });
    const v = await res.promise;
    if (v === 'new') return newFolder();
    return v ? folderById(v) : null;
  }

  function startPick(folderId) {
    state.pickFor = folderId;
    go('#/geral');
    enterSelection();
    toast('Adicionar à pasta', 'Toque nas fotos e vídeos e depois em "Adicionar".', 'i-folder');
  }

  /* ======================= Cores das pastas ======================= */

  const DEFAULT_FOLDER_COLOR = '#ffd966';
  const FOLDER_COLORS = [
    ['Azul', '#5aa9ff'], ['Turquesa', '#45d0c8'], ['Verde', '#8fd94a'], ['Laranja', '#ffa53d'], ['Vermelho', '#ff6a55'],
    ['Rosa', '#ff8cc6'], ['Roxo', '#a98bff'], ['Cinza', '#b4bfca'], ['Grafite', '#5d6773']
  ];

  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  // Tons da pasta (fundo, aba, frente e bordas) derivados da cor escolhida; sem cor fica o amarelo padrão do CSS
  function folderStyle(hex) {
    if (!hex) return null;
    const [h, s, l] = hexToHsl(hex);
    const c = (sat, lum, a = 1) => `hsla(${h}, ${Math.round(sat)}%, ${Math.round(lum)}%, ${a})`;
    const up = (k) => l + (100 - l) * k;
    const down = (k) => l * (1 - k);
    return [
      `--fd-back1:${c(s * .9, up(.03))}`,
      `--fd-back2:${c(s * .7, down(.27))}`,
      `--fd-tab:${c(s * .85, down(.04))}`,
      `--fd-edge:${c(s * .8, down(.46))}`,
      `--fd-front1:${c(s, up(.53), .92)}`,
      `--fd-front2:${c(s, l, .95)}`,
      `--fd-front3:${c(s * .85, down(.17), .97)}`,
      `--fd-front-edge:${c(s * .8, down(.4))}`
    ].join(';');
  }

  // Resolve com a cor escolhida (null = padrão) ou undefined se cancelar
  async function chooseColor(name, current) {
    let value = current || null;
    let [h, s, l] = hexToHsl(value || DEFAULT_FOLDER_COLOR);
    const body = el('div', { class: 'color-picker' });
    const preview = el('div', { class: 'folder-art' }, '<div class="folder-back"></div><div class="folder-front"></div>');
    const swatches = el('div', { class: 'swatches' });
    const sliders = el('div', { class: 'sliders' });
    const slider = (label, min, max) => {
      const input = el('input', { type: 'range', min, max, step: 1, 'aria-label': label });
      const row = el('label', {}, `<span>${label}</span>`);
      row.append(input);
      sliders.append(row);
      return input;
    };
    const hue = slider('Matiz', 0, 359);
    const sat = slider('Saturação', 0, 100);
    const lum = slider('Brilho', 15, 85);

    const paint = () => {
      preview.setAttribute('style', folderStyle(value) || '');
      swatches.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', (b.dataset.c || null) === value));
      hue.value = h; sat.value = s; lum.value = l;
      sat.style.background = `linear-gradient(90deg, ${hslToHex(h, 0, l)}, ${hslToHex(h, 100, l)})`;
      lum.style.background = `linear-gradient(90deg, ${hslToHex(h, s, 15)}, ${hslToHex(h, s, 50)}, ${hslToHex(h, s, 85)})`;
    };
    const pick = (c) => {
      value = c;
      [h, s, l] = hexToHsl(c || DEFAULT_FOLDER_COLOR);
      paint();
    };
    [['Padrão', null], ...FOLDER_COLORS].forEach(([label, c]) => {
      swatches.append(el('button', {
        class: 'swatch', type: 'button', title: label, 'aria-label': label, 'data-c': c,
        style: `background:${c || DEFAULT_FOLDER_COLOR}`, onclick: () => pick(c)
      }));
    });
    [hue, sat, lum].forEach((input) => input.addEventListener('input', () => {
      h = +hue.value; s = +sat.value; l = +lum.value;
      value = hslToHex(h, s, l);
      paint();
    }));

    body.append(el('div', { class: 'color-top' }), sliders);
    body.firstChild.append(preview, swatches);
    paint();
    const d = dialog({
      title: 'Cor da pasta',
      icon: 'i-palette',
      message: `Escolha uma cor para "${name}" ou ajuste a sua:`,
      body,
      buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancelar', value: null }]
    });
    return (await d.promise) === 'ok' ? value : undefined;
  }

  // target: { folder: id } para pastas do usuário ou { album: nome } para pastas do aparelho/importadas
  async function editColor(target) {
    const f = target.folder && folderById(target.folder);
    if (target.folder && !f) return;
    const name = f ? f.name : target.album;
    const color = await chooseColor(name, f ? f.color : state.albumColors[name]);
    if (color === undefined) return;
    if (f) {
      if (color) f.color = color; else delete f.color;
      await saveFolders([f]);
    } else {
      if (color) state.albumColors[name] = color; else delete state.albumColors[name];
      store.set('dv-album-colors', JSON.stringify(state.albumColors));
    }
    render({ keepScroll: true });
    toast('Cor da pasta', color ? `"${name}" está com a nova cor.` : `"${name}" voltou à cor padrão.`, 'i-palette');
  }

  /* ======================= Roteamento ======================= */

  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').map((p) => { try { return decodeURIComponent(p); } catch (e) { return p; } });
    const tab = TABS[parts[0]] ? parts[0] : 'geral';
    const r = { tab, album: null, folder: null };
    if (tab === 'albuns' && parts[2]) {
      if (parts[1] === 'p') r.folder = parts[2];
      else if (parts[1] === 'a') r.album = parts[2];
    }
    return r;
  }

  const sameRoute = (a, b) => a.tab === b.tab && a.album === b.album && a.folder === b.folder;
  const isDrill = (hash) => /^#\/albuns\/[ap]\//.test(hash);

  // Abas trocam o endereço sem empilhar histórico; abrir uma pasta empilha (no navegador)
  function go(hash) {
    // Subir de uma pasta aberta no navegador volta no histórico em vez de empilhar
    if (hash === '#/albuns' && !IS_NATIVE && history.state && history.state.drill) {
      history.back();
      return;
    }
    if (location.hash !== hash) {
      if (isDrill(hash) && !IS_NATIVE) history.pushState({ drill: true }, '', hash);
      else history.replaceState(null, '', hash);
    }
    onRoute();
  }

  function onRoute() {
    const r = parseRoute();
    if (r.folder && !state.loading && !folderById(r.folder)) return go('#/albuns');
    if (sameRoute(r, state.route) && !state.forceRoute) return;
    state.forceRoute = false;
    state.route = r;
    if (state.selecting && !(state.pickFor && r.tab === 'geral')) exitSelection(false);
    closeStart();
    render();
  }

  window.addEventListener('hashchange', onRoute);
  window.addEventListener('popstate', () => {
    if (!ui.viewer.hidden) { hideViewer(); return; }
    onRoute();
  });

  // Links internos (#/...) passam pelo roteador
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#/"]');
    if (!a) return;
    e.preventDefault();
    go(a.getAttribute('href'));
  });

  const goUp = () => go('#/albuns');

  /* ======================= Renderização ======================= */

  function render({ keepScroll = false } = {}) {
    const { tab } = state.route;
    const scroll = keepScroll ? ui.content.scrollTop : 0;
    const minCount = keepScroll ? state.rendered : 0;

    document.querySelectorAll('.task').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    ui.back.disabled = !(state.route.album || state.route.folder);
    renderBreadcrumb();
    renderTaskbarBadges();

    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    ui.content.innerHTML = '';
    ui.content.classList.toggle('selecting', state.selecting);
    state.rendered = 0;

    const list = currentList();
    if (state.loading) ui.content.append(el('div', { class: 'empty' }, `${icon('i-photos')}<p>Carregando a galeria…</p>`));
    else if (needsAccess()) renderAccess();
    else if (tab === 'albuns' && !state.route.album && !state.route.folder) renderAlbums();
    else if (!list.length) renderEmpty();
    else {
      if (tab === 'lixeira') {
        ui.content.append(el('div', { class: 'info-strip' },
          `${icon('i-info')}<span>Itens excluídos ficam aqui por ${TRASH_DAYS} dias antes de serem removidos permanentemente.</span>`));
      } else if (IS_NATIVE && state.access === 'limited' && tab === 'geral') {
        const strip = el('div', { class: 'info-strip' },
          `${icon('i-info')}<span>Acesso limitado: o app vê só as fotos que você escolheu.</span>`);
        strip.append(el('button', { class: 'btn', onclick: requestAccess }, 'Gerenciar'));
        ui.content.append(strip);
      }
      renderGrid(list, { headers: tab !== 'lixeira', trash: tab === 'lixeira' }, minCount);
    }
    ui.content.scrollTop = scroll;
    renderCommandbar();
    renderStatus();
  }

  const needsAccess = () => IS_NATIVE && state.access !== 'granted' && state.access !== 'limited' && state.route.tab !== 'lixeira';

  function renderAccess() {
    const denied = state.access === 'denied' && state.askedAccess;
    const box = el('div', { class: 'empty' }, `${icon('i-photos')}
      <h2>Permita o acesso às suas fotos</h2>
      <p>O FoldAero mostra as fotos, vídeos e GIFs do seu celular automaticamente. Nada sai do aparelho.</p>`);
    const row = el('div', { class: 'row' });
    row.append(el('button', { class: 'btn primary', onclick: requestAccess }, `${icon('i-photos')}${denied ? 'Abrir configurações' : 'Permitir acesso'}`));
    box.append(row);
    ui.content.append(box);
  }

  function renderBreadcrumb() {
    const { tab, album, folder } = state.route;
    const sep = icon('i-chevron', 'sep');
    let html = `<img src="assets/icon-64.png" alt=""><span>Bibliotecas</span>${sep}`;
    const f = folder && folderById(folder);
    if (album || f) html += `<a href="#/albuns">Álbuns</a>${sep}<span>${esc(album || f.name)}</span>`;
    else html += `<span>${TABS[tab]}</span>`;
    ui.breadcrumb.innerHTML = html;
  }

  function renderTaskbarBadges() {
    const n = trashed().length;
    const task = $('.task[data-tab="lixeira"]');
    $('use', task).setAttribute('href', n ? '#i-trash-full' : '#i-trash');
    let badge = $('.count', task);
    if (n) {
      if (!badge) task.append(badge = el('span', { class: 'count' }));
      badge.textContent = n > 99 ? '99+' : n;
    } else if (badge) badge.remove();
  }

  function renderGrid(list, opts, minCount) {
    const grid = el('div', { class: 'grid' });
    const sentinel = el('div', { class: 'sentinel' });
    ui.content.append(grid);
    let i = 0;
    let lastKey = null;

    const g = grouper();
    const counts = new Map();
    if (opts.headers) list.forEach((it) => { const k = g.key(it.date); counts.set(k, (counts.get(k) || 0) + 1); });

    const appendChunk = () => {
      const frag = document.createDocumentFragment();
      const start = i;
      const end = Math.min(list.length, i + CHUNK);
      for (; i < end; i++) {
        const it = list[i];
        if (opts.headers) {
          const k = g.key(it.date);
          if (k !== lastKey) {
            lastKey = k;
            frag.append(el('h3', { class: 'group-header' }, `${esc(g.label(k, it.date))} <small>(${counts.get(k)})</small>`));
          }
        }
        frag.append(tile(it, opts, i));
      }
      grid.append(frag);
      grid.append(sentinel);
      state.rendered = i;
      hydrate(list.slice(start, end));
      if (i >= list.length && state.observer) { state.observer.disconnect(); state.observer = null; }
    };

    do appendChunk(); while (i < list.length && i < minCount);

    if (i < list.length) {
      state.observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) appendChunk();
      }, { root: ui.content, rootMargin: '900px 0px' });
      state.observer.observe(sentinel);
    }
  }

  function tile(it, opts, idx) {
    const b = el('button', { class: 'tile' + (state.selected.has(it.id) ? ' selected' : ''), 'data-id': it.id, 'data-idx': idx, 'aria-label': displayName(it) });
    // GIFs usam o arquivo original para animar na grade
    const src = (it.type === 'gif' && fullSrc(it)) || thumbSrc(it);
    let html = '';
    if (it.src !== 'device' && it.type === 'video' && !it.thumb) {
      html += `<video src="${blobUrl(it, 'full')}#t=0.1" muted playsinline preload="metadata"></video>`;
    } else {
      html += `<img ${src ? `src="${src}"` : ''} alt="" loading="lazy" decoding="async">`;
    }
    if (it.type === 'video') {
      html += `<span class="badge badge-play">${icon('i-play')}</span>`;
      html += `<span class="badge badge-type">${fmtDuration(it.duration)}</span>`;
    }
    if (it.type === 'gif') html += '<span class="badge badge-type gif">GIF</span>';
    if (it.favorite && !opts.trash) html += `<span class="badge badge-fav">${icon('i-star')}</span>`;
    if (opts.trash) html += `<span class="badge badge-days">${plural(daysLeft(it), 'dia', 'dias')}</span>`;
    html += `<span class="check">${icon('i-check')}</span>`;
    b.innerHTML = html;
    return b;
  }

  function folderCard(href, name, items, color, target) {
    const previews = items.slice(0, 3).reverse().map((i) => {
      const src = (i.type === 'gif' && fullSrc(i)) || thumbSrc(i);
      return i.src !== 'device' && i.type === 'video' && !i.thumb
        ? '<span></span>'
        : `<img ${src ? `src="${src}"` : ''} alt="" loading="lazy" data-id="${esc(i.id)}">`;
    }).join('');
    return el('a', { class: 'folder', href, style: folderStyle(color), 'data-folder': target.folder, 'data-album': target.album }, `
      <div class="folder-art">
        <div class="folder-back"></div>
        <div class="folder-papers">${previews}</div>
        <div class="folder-front"></div>
      </div>
      <span class="folder-name">${esc(name)}</span>
      <span class="folder-count">${plural(items.length, 'item', 'itens')}</span>`);
  }

  function renderAlbums() {
    const albums = albumsList();
    const folders = sortedFolders();
    if (!albums.length && !folders.length) return renderEmpty();
    const previews = [];

    if (folders.length) {
      ui.content.append(el('h3', { class: 'group-header' }, `Minhas pastas <small>(${folders.length})</small>`));
      const wrap = el('div', { class: 'folders' });
      folders.forEach((f) => {
        const items = folderItems(f);
        previews.push(...items.slice(0, 3));
        wrap.append(folderCard(`#/albuns/p/${encodeURIComponent(f.id)}`, f.name, items, f.color, { folder: f.id }));
      });
      ui.content.append(wrap);
    }
    if (albums.length) {
      if (folders.length) ui.content.append(el('h3', { class: 'group-header' }, `${IS_NATIVE ? 'Pastas do aparelho' : 'Pastas importadas'} <small>(${albums.length})</small>`));
      const wrap = el('div', { class: 'folders' });
      albums.forEach(([name, items]) => {
        previews.push(...items.slice(0, 3));
        wrap.append(folderCard(`#/albuns/a/${encodeURIComponent(name)}`, name, items, state.albumColors[name], { album: name }));
      });
      ui.content.append(wrap);
    }
    // iOS: miniaturas das capas chegam depois
    if (NM && NM.async) {
      NM.loadThumbs(previews.filter((i) => i.src === 'device'), (batch) => batch.forEach((i) => {
        ui.content.querySelectorAll(`.folder-papers img[data-id="${CSS.escape(i.id)}"]`).forEach((img) => { img.src = NM.thumbUrl(i); });
      }));
    }
  }

  function renderEmpty() {
    const { tab, album, folder } = state.route;
    const states = {
      geral: ['i-photos', 'Sua galeria está vazia', IS_NATIVE
        ? 'Nenhuma foto ou vídeo foi encontrado no aparelho.'
        : 'Importe fotos, vídeos e GIFs do seu dispositivo para começar.'],
      albuns: ['i-folder', 'Nenhum álbum ainda', IS_NATIVE
        ? 'Crie uma pasta para organizar suas fotos do seu jeito.'
        : 'Importe uma pasta e cada pasta vira um álbum, como no Windows Explorer.'],
      favoritos: ['i-star', 'Nenhum favorito', 'Toque na estrela ao visualizar uma mídia para guardá-la aqui.'],
      lixeira: ['i-trash', 'A Lixeira está vazia', `Itens excluídos ficam aqui por ${TRASH_DAYS} dias antes da exclusão permanente.`]
    };
    let [ico, h, p] = states[tab];
    if (album) [ico, h, p] = ['i-folder', 'Esta pasta está vazia', 'Não há itens neste álbum.'];
    if (folder) [ico, h, p] = ['i-folder', 'Esta pasta está vazia', 'Toque em "Adicionar" para escolher fotos e vídeos.'];
    const box = el('div', { class: 'empty' }, `${icon(ico)}<h2>${h}</h2><p>${p}</p>`);
    const row = el('div', { class: 'row' });
    if (folder) {
      row.append(el('button', { class: 'btn primary', onclick: () => startPick(folder) }, `${icon('i-photos')}Adicionar`));
    } else if (tab === 'albuns') {
      row.append(el('button', { class: 'btn primary', onclick: () => newFolder().then((f) => f && render()) }, `${icon('i-folder')}Nova pasta`));
    }
    if (!IS_NATIVE && (tab === 'geral' || (tab === 'albuns' && !folder))) {
      row.append(
        el('button', { class: 'btn' + (tab === 'geral' ? ' primary' : ''), onclick: () => ui.fileInput.click() }, `${icon('i-photos')}Importar`),
        el('button', { class: 'btn', onclick: loadSamples }, `${icon('i-sample')}Imagens de exemplo`)
      );
    }
    if (row.children.length) box.append(row);
    ui.content.append(box);
  }

  function cmd(label, ico, onclick, extra = {}) {
    return el('button', { class: 'cmd' + (extra.cls ? ' ' + extra.cls : ''), onclick, disabled: extra.disabled, 'aria-label': label, title: label },
      `${ico ? icon(ico) : ''}<span>${label}</span>`);
  }

  function zoomControl() {
    const box = el('div', { class: 'zoom-ctl' });
    const range = el('input', { type: 'range', min: 2, max: 6, step: 1, value: 8 - state.cols, 'aria-label': 'Tamanho dos ícones' });
    range.addEventListener('input', () => setCols(8 - +range.value));
    box.append(
      el('button', { class: 'cmd', 'aria-label': 'Ícones menores', onclick: () => setCols(state.cols + 1) }, icon('i-zoom-out')),
      range,
      el('button', { class: 'cmd', 'aria-label': 'Ícones maiores', onclick: () => setCols(state.cols - 1) }, icon('i-zoom'))
    );
    return box;
  }

  // Executa uma ação da seleção e redesenha mantendo a rolagem
  const afterSelection = (fn) => async () => {
    if ((await fn()) === false) return;
    exitSelection(false);
    render({ keepScroll: true });
  };

  function renderCommandbar() {
    const { tab, album, folder } = state.route;
    const bar = ui.commandbar;
    bar.innerHTML = '';
    bar.classList.toggle('selecting', state.selecting);
    const isTrash = tab === 'lixeira';
    const list = state.loading || needsAccess() ? [] : currentList();
    const f = folder && folderById(folder);

    if (state.selecting) {
      const n = state.selected.size;
      const ids = () => [...state.selected];
      bar.append(
        cmd('Cancelar', 'i-close', () => {
          const back = state.pickFor;
          exitSelection();
          if (back) go(`#/albuns/p/${encodeURIComponent(back)}`);
        }, { cls: 'cancel' }),
        el('span', { class: 'cmd-label' }, plural(n, 'selecionado', 'selecionados')),
        cmd(n === list.length ? 'Nenhum' : 'Todos', n ? 'i-select' : 'i-select-off', () => {
          if (n === list.length) state.selected.clear();
          else list.forEach((i) => state.selected.add(i.id));
          syncSelection();
        }),
        el('span', { class: 'cmd-sep' })
      );
      const pick = state.pickFor && folderById(state.pickFor);
      if (pick) {
        bar.append(cmd('Adicionar', 'i-import', async () => {
          await addToFolder(pick, ids());
          exitSelection(false);
          go(`#/albuns/p/${encodeURIComponent(pick.id)}`);
        }, { disabled: !n }));
      } else if (isTrash) {
        bar.append(
          cmd('Restaurar', 'i-restore', afterSelection(() => restore(ids())), { disabled: !n }),
          cmd('Excluir', 'i-delete', afterSelection(() => purge(ids())), { disabled: !n, cls: 'danger' })
        );
      } else {
        const allFav = n > 0 && ids().every((id) => byId(id).favorite);
        bar.append(cmd(allFav ? 'Desfavoritar' : 'Favoritar', 'i-star', afterSelection(() => setFavorite(ids(), !allFav)), { disabled: !n }));
        if (f) {
          bar.append(cmd('Remover da pasta', 'i-folder', afterSelection(() => removeFromFolder(f, ids())), { disabled: !n }));
        } else {
          bar.append(cmd('Adicionar à pasta', 'i-folder', afterSelection(async () => {
            const target = await chooseFolder();
            if (!target) return false;
            await addToFolder(target, ids());
          }), { disabled: !n }));
        }
        bar.append(cmd('Excluir', 'i-trash', afterSelection(() => moveToTrash(ids())), { disabled: !n, cls: 'danger' }));
      }
      return;
    }

    if (tab === 'albuns' && !album && !folder) {
      bar.append(cmd('Nova pasta', 'i-import', () => newFolder().then((nf) => nf && render({ keepScroll: true }))));
      if (IS_NATIVE) bar.append(cmd('Atualizar', 'i-restore', () => rescan(true)));
      else bar.append(cmd('Importar pasta', 'i-folder', () => ui.folderInput.click()));
      return;
    }

    if (f) {
      bar.append(cmd('Adicionar', 'i-import', () => startPick(f.id)));
    } else if (isTrash) {
      bar.append(
        cmd('Esvaziar', 'i-delete', async () => {
          if (await purge(list.map((i) => i.id))) render();
        }, { disabled: !list.length, cls: 'danger' }),
        cmd('Restaurar tudo', 'i-restore', async () => { await restore(list.map((i) => i.id)); render(); }, { disabled: !list.length })
      );
    } else if (tab !== 'favoritos' && !IS_NATIVE) {
      bar.append(cmd('Importar', 'i-import', () => ui.fileInput.click()));
    }
    bar.append(cmd('Selecionar', 'i-select-off', () => enterSelection(), { disabled: !list.length }));
    if (album || f) bar.append(cmd('Cor', 'i-palette', () => editColor({ album, folder }), { cls: 'ico' }));
    if (f) {
      bar.append(
        cmd('Renomear', 'i-rename', () => renameFolder(f), { cls: 'ico' }),
        cmd('Excluir pasta', 'i-delete', () => deleteFolder(f), { cls: 'ico' })
      );
    }
    bar.append(el('span', { class: 'cmd-spacer' }), zoomControl());
  }

  function renderStatus() {
    const { tab, album, folder } = state.route;
    if (state.selecting) {
      if (state.selected.size) ui.statusbar.innerHTML = `${icon('i-select')}${plural(state.selected.size, 'item selecionado', 'itens selecionados')}`;
      else ui.statusbar.textContent = 'Toque nos itens ou arraste o dedo sobre eles';
      return;
    }
    if (state.loading || needsAccess()) {
      ui.statusbar.textContent = '';
      return;
    }
    if (tab === 'albuns' && !album && !folder) {
      const n = albumsList().length + state.folders.length;
      ui.statusbar.innerHTML = `${icon('i-folder')}${plural(n, 'pasta', 'pastas')} · ${plural(active().length, 'item', 'itens')}`;
      return;
    }
    const list = currentList();
    const ico = tab === 'favoritos' ? 'i-star' : tab === 'lixeira' ? 'i-trash' : (album || folder) ? 'i-folder' : 'i-photos';
    const s = summary(list);
    ui.statusbar.innerHTML = `${icon(ico)}${plural(list.length, 'item', 'itens')}${s ? ' — ' + s : ''}`;
  }

  function setCols(n) {
    n = Math.min(6, Math.max(2, n));
    if (n === state.cols) return;
    state.cols = n;
    document.documentElement.style.setProperty('--cols', n);
    store.set('dv-cols', n);
    const range = $('.zoom-ctl input', ui.commandbar);
    if (range) range.value = 8 - n;
  }

  /* ======================= Seleção ======================= */

  function enterSelection(firstId) {
    state.selecting = true;
    state.selected.clear();
    if (firstId) state.selected.add(firstId);
    ui.content.classList.add('selecting');
    syncSelection();
  }

  function exitSelection(redraw = true) {
    endSweep();
    state.selecting = false;
    state.pickFor = null;
    state.selected.clear();
    ui.content.classList.remove('selecting');
    if (redraw) syncSelection();
  }

  function syncSelection() {
    ui.content.querySelectorAll('.tile').forEach((t) => t.classList.toggle('selected', state.selected.has(t.dataset.id)));
    renderCommandbar();
    renderStatus();
  }

  function toggleSelected(tileEl) {
    const id = tileEl.dataset.id;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    tileEl.classList.toggle('selected', state.selected.has(id));
    renderCommandbar();
    renderStatus();
  }

  /* ======================= Interação com a grade ======================= */

  // Seleção arrastando o dedo: começa com o toque longo ou, já no modo seleção, ao arrastar
  // para o lado (arrastar na vertical continua rolando a lista)
  let press = null; // toque em andamento sobre um bloco
  let sweep = null;

  ui.content.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.tile');
    if (!t || e.button > 0) return;
    press = {
      el: t, x: e.clientX, y: e.clientY, long: false,
      timer: setTimeout(() => {
        press.long = true;
        navigator.vibrate && navigator.vibrate(15);
        const adding = !state.selected.has(press.el.dataset.id);
        if (!state.selecting) enterSelection();
        startSweep(press.el, adding, press.x, press.y);
      }, 450)
    };
  });
  ui.content.addEventListener('pointermove', (e) => {
    const mouse = e.pointerType === 'mouse';
    if (sweep) {
      if (mouse) sweepAt(e.clientX, e.clientY);
      return;
    }
    if (!press || press.long || Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 10) return;
    if (state.selecting && mouse) return beginDrag(e.clientX, e.clientY);
    if (state.selecting) return; // toque: a direção é decidida no touchmove
    clearTimeout(press.timer);
    press = null;
  });
  // Durante a seleção por arraste o dedo não rola a lista (a rolagem é automática nas bordas)
  ui.content.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const { clientX: x, clientY: y } = e.touches[0];
    if (!sweep && press && !press.long && state.selecting) {
      const dx = x - press.x, dy = y - press.y;
      if (Math.hypot(dx, dy) > 10) {
        if (Math.abs(dx) > Math.abs(dy)) beginDrag(x, y);
        else { clearTimeout(press.timer); press = null; }
      }
    }
    if (!sweep) return;
    e.preventDefault();
    sweepAt(x, y);
  }, { passive: false });

  function beginDrag(x, y) {
    clearTimeout(press.timer);
    press.long = true; // o clique que vem em seguida não alterna o bloco
    startSweep(press.el, !state.selected.has(press.el.dataset.id), press.x, press.y);
    sweepAt(x, y);
  }
  const endPress = () => {
    if (press) clearTimeout(press.timer);
    endSweep();
  };
  ui.content.addEventListener('pointercancel', () => { endPress(); press = null; });
  ui.content.addEventListener('pointerup', endPress);
  ui.content.addEventListener('touchend', endSweep);
  ui.content.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tile')) return e.preventDefault();
    // Toque longo (ou botão direito) numa pasta abre a escolha de cor
    const card = e.target.closest('.folder');
    if (!card) return;
    e.preventDefault();
    navigator.vibrate && navigator.vibrate(15);
    editColor({ folder: card.dataset.folder, album: card.dataset.album });
  });

  function startSweep(tileEl, adding, x, y) {
    sweep = { anchor: +tileEl.dataset.idx, last: -1, adding, base: new Set(state.selected), x, y, raf: 0 };
    sweepTo(sweep.anchor);
    sweep.raf = requestAnimationFrame(sweepScroll);
  }

  function endSweep() {
    if (!sweep) return;
    cancelAnimationFrame(sweep.raf);
    sweep = null;
  }

  function sweepAt(x, y) {
    sweep.x = x;
    sweep.y = y;
    const hit = document.elementFromPoint(x, y);
    const t = hit && hit.closest('.tile');
    if (t && t.dataset.idx) sweepTo(+t.dataset.idx);
  }

  // Seleciona (ou desmarca) todo o intervalo entre o primeiro bloco e o bloco sob o dedo
  function sweepTo(idx) {
    if (!sweep || idx === sweep.last) return;
    sweep.last = idx;
    const list = currentList();
    const lo = Math.min(sweep.anchor, idx), hi = Math.max(sweep.anchor, idx);
    state.selected.clear();
    sweep.base.forEach((id) => state.selected.add(id));
    for (let i = lo; i <= hi && i < list.length; i++) {
      if (sweep.adding) state.selected.add(list[i].id);
      else state.selected.delete(list[i].id);
    }
    syncSelection();
  }

  function sweepScroll() {
    if (!sweep) return;
    const r = ui.content.getBoundingClientRect();
    const edge = 72;
    let v = 0;
    if (sweep.y < r.top + edge) v = -(r.top + edge - sweep.y) / 3;
    else if (sweep.y > r.bottom - edge) v = (sweep.y - (r.bottom - edge)) / 3;
    if (v) {
      ui.content.scrollTop += Math.max(-28, Math.min(28, v));
      sweepAt(sweep.x, sweep.y);
    }
    sweep.raf = requestAnimationFrame(sweepScroll);
  }

  ui.content.addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const wasLong = press && press.long;
    press = null;
    if (wasLong) return;
    if (state.selecting) return toggleSelected(t);
    const list = currentList();
    openViewer(list, list.findIndex((i) => i.id === t.dataset.id));
  });

  // Pinça com dois dedos ajusta o tamanho da grade
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  ui.content.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) pinch = { d: dist(e.touches) };
  }, { passive: true });
  ui.content.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    const r = dist(e.touches) / pinch.d;
    if (r > 1.3) { setCols(state.cols - 1); pinch.d = dist(e.touches); }
    else if (r < 0.77) { setCols(state.cols + 1); pinch.d = dist(e.touches); }
  }, { passive: true });
  ui.content.addEventListener('touchend', () => (pinch = null));

  /* ======================= Visualizador ======================= */

  const MAX_ZOOM = 6;
  const view = { list: [], index: 0, zoom: 1, rot: 0, panX: 0, panY: 0, show: null, trash: false, dirty: false, autoplay: false };

  function openViewer(list, index) {
    if (index < 0) return;
    // Cópia: a lista memorizada não pode ser alterada pelo visualizador
    Object.assign(view, { list: list.slice(), index, trash: state.route.tab === 'lixeira', dirty: false, autoplay: true });
    ui.viewer.hidden = false;
    if (!IS_NATIVE) history.pushState({ viewer: true }, '');
    showSlide();
  }

  function closeViewer() {
    if (history.state && history.state.viewer) history.back();
    else hideViewer();
  }

  function hideViewer() {
    stopSlideshow();
    ui.viewer.hidden = true;
    ui.stage.innerHTML = '';
    if (view.dirty) render({ keepScroll: true });
  }

  const current = () => view.list[view.index];

  function setMediaSrc(it, node, url) {
    if (current() === it && node.isConnected && url) node.src = url;
  }

  function updateViewerTitle(it) {
    $('#v-name').textContent = displayName(it);
    $('#v-rename').hidden = view.trash;
    const meta = view.trash
      ? `Excluído · ${plural(daysLeft(it), 'dia restante', 'dias restantes')}`
      : `${fmtDate(it.date)} · ${it.album}`;
    $('#v-meta').textContent = `${view.index + 1} de ${view.list.length} · ${meta}`;
  }

  // No app nativo o vídeo abre no player do sistema (decodificação por hardware, sempre em retrato)
  function playNative(it) {
    NM.play(it).catch(() => toast('Não foi possível reproduzir', 'O vídeo não pôde ser aberto.', 'i-warning'));
  }

  function showSlide(dir = 0) {
    const it = current();
    if (!it) return closeViewer();
    view.zoom = 1; view.rot = 0; view.panX = 0; view.panY = 0;
    const slide = el('div', { class: 'slide' });
    let media;
    if (it.type === 'video' && IS_NATIVE) {
      media = el('img', { class: 'poster', alt: displayName(it), draggable: 'false' });
      const poster = NM.thumbUrl(it, 1080);
      if (poster) media.src = poster;
      else NM.loadThumbs([it], () => setMediaSrc(it, media, NM.thumbUrl(it)));
      slide.append(media, el('button', { class: 'vplay', 'aria-label': 'Reproduzir vídeo', onclick: () => playNative(it) }, icon('i-play')));
      if (view.autoplay && !view.show) playNative(it);
    } else {
      const full = fullSrc(it);
      if (it.type === 'video') {
        const poster = it.thumb && blobUrl(it, 'thumb');
        media = el('video', { controls: true, autoplay: true, playsinline: true, controlslist: 'nofullscreen noremoteplayback', disablepictureinpicture: true, poster: poster || false });
        media.addEventListener('ended', () => { if (view.show) go1(1, true); });
      } else {
        media = el('img', { alt: displayName(it), draggable: 'false' });
      }
      if (full) media.src = full;
      else {
        if (it.type !== 'video' && thumbSrc(it)) media.src = thumbSrc(it);
        NM.loadFull(it).then((url) => { setMediaSrc(it, media, url); if (current() === it) updateViewerTitle(it); })
          .catch(() => toast('Não foi possível abrir', 'O arquivo não está disponível.', 'i-warning'));
      }
      slide.append(media);
    }
    view.autoplay = false;
    ui.stage.innerHTML = '';
    ui.stage.append(slide);
    if (dir) slide.animate([{ transform: `translateX(${dir * 40}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'ease-out' });
    updateViewerTitle(it);
    renderViewerBar();
  }

  function vb(label, ico, onclick, extra = {}) {
    return el('button', { class: 'vb' + (extra.cls ? ' ' + extra.cls : ''), 'aria-label': label, title: label, onclick, disabled: extra.disabled }, icon(ico));
  }

  function renderViewerBar() {
    const it = current();
    const bar = ui.vbar;
    bar.innerHTML = '';
    const left = el('div', { class: 'vb-group' });
    const mid = el('div', { class: 'vb-group' });
    const right = el('div', { class: 'vb-group' });
    const single = view.list.length < 2;
    const still = it.type !== 'video';

    if (view.trash) {
      left.append(vb('Restaurar', 'i-restore', async () => {
        await restore([it.id]);
        view.dirty = true;
        dropCurrent();
      }));
    } else {
      left.append(
        vb(it.favorite ? 'Remover dos favoritos' : 'Favoritar', it.favorite ? 'i-star' : 'i-star-off', async () => {
          await setFavorite([it.id], !it.favorite);
          view.dirty = true;
          renderViewerBar();
        }, { cls: it.favorite ? 'on' : '' }),
        vb('Zoom', view.zoom > 1 ? 'i-zoom-out' : 'i-zoom', () => setZoom(view.zoom > 1 ? 1 : 2.5), { disabled: !still })
      );
    }

    mid.append(
      vb('Anterior', 'i-prev', () => go1(-1), { disabled: single }),
      el('button', { class: 'vb vb-main', 'aria-label': view.show ? 'Pausar apresentação' : 'Apresentação de slides', onclick: toggleSlideshow, disabled: single },
        icon(view.show ? 'i-pause' : 'i-slideshow')),
      vb('Próximo', 'i-next', () => go1(1), { disabled: single })
    );

    if (!view.trash) {
      right.append(
        vb('Editar', 'i-crop', () => openEditor(it), { disabled: it.type !== 'image' }),
        vb('Girar', 'i-rotate', rotate, { disabled: !still })
      );
    }
    right.append(vb(view.trash ? 'Excluir permanentemente' : 'Excluir', 'i-delete', async () => {
      const ok = view.trash ? await purge([it.id]) : await moveToTrash([it.id]);
      if (ok) { view.dirty = true; dropCurrent(); }
    }));

    bar.append(left, mid, right);
  }

  // Remove o item atual da lista do visualizador (após excluir/restaurar)
  function dropCurrent() {
    view.list.splice(view.index, 1);
    if (!view.list.length) return closeViewer();
    view.index = Math.min(view.index, view.list.length - 1);
    showSlide();
  }

  function go1(step, wrap = false) {
    const n = view.list.length;
    let i = view.index + step;
    if (wrap || view.show) i = (i + n) % n;
    if (i < 0 || i >= n) return bump(step);
    view.index = i;
    showSlide(step);
  }

  function bump(step) {
    const s = $('.slide', ui.stage);
    s && s.animate([{ transform: 'none' }, { transform: `translateX(${-step * 24}px)` }, { transform: 'none' }], { duration: 220 });
  }

  /* ---------- Zoom livre (pinça), arrastar e girar ---------- */

  const zoomable = () => $('.slide img:not(.poster)', ui.stage);

  // Escala extra para a foto girada de lado continuar cabendo na tela
  function rotationFit(media) {
    if (!(view.rot % 180)) return 1;
    return Math.min(ui.stage.clientWidth / media.clientHeight, ui.stage.clientHeight / media.clientWidth, 1.6);
  }

  // Impede que a foto ampliada seja arrastada para fora da tela
  function clampPan() {
    const media = zoomable();
    if (!media) return;
    const k = view.zoom * rotationFit(media);
    let w = media.clientWidth * k, h = media.clientHeight * k;
    if (view.rot % 180) [w, h] = [h, w];
    const mx = Math.max(0, (w - ui.stage.clientWidth) / 2);
    const my = Math.max(0, (h - ui.stage.clientHeight) / 2);
    view.panX = Math.max(-mx, Math.min(mx, view.panX));
    view.panY = Math.max(-my, Math.min(my, view.panY));
  }

  function applyTransform() {
    const media = zoomable();
    if (!media) return;
    media.style.transform = `translate(${view.panX}px, ${view.panY}px) rotate(${view.rot}deg) scale(${view.zoom * rotationFit(media)})`;
  }

  // Muda o zoom mantendo parado o ponto (x, y) da tela (centro da pinça ou do toque duplo)
  function zoomAt(z, x, y) {
    z = Math.max(1, Math.min(MAX_ZOOM, z));
    const r = ui.stage.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const k = z / view.zoom;
    view.panX = (x - cx) - k * (x - cx - view.panX);
    view.panY = (y - cy) - k * (y - cy - view.panY);
    view.zoom = z;
    if (z === 1) { view.panX = 0; view.panY = 0; }
    clampPan();
    applyTransform();
  }

  function setZoom(z) {
    const r = ui.stage.getBoundingClientRect();
    zoomAt(z, r.left + r.width / 2, r.top + r.height / 2);
    renderViewerBar();
  }

  function rotate() {
    view.rot = (view.rot + 90) % 360;
    clampPan();
    applyTransform();
  }

  function toggleSlideshow() {
    if (view.show) return stopSlideshow();
    view.show = setInterval(() => {
      const it = current();
      if (it && it.type === 'video' && !IS_NATIVE) return; // no navegador, vídeos avançam ao terminar
      go1(1, true);
    }, 3500);
    renderViewerBar();
    toast('Apresentação de slides', 'Toque no botão central para pausar.', 'i-slideshow');
    // Se a apresentação começa num vídeo já terminado, avança na hora
    const v = $('.slide video', ui.stage);
    if (v && v.ended) go1(1, true);
  }

  function stopSlideshow() {
    if (!view.show) return;
    clearInterval(view.show);
    view.show = null;
    if (!ui.viewer.hidden) renderViewerBar();
  }

  // Gestos: deslizar navega, pinça amplia livremente, arrastar move a foto ampliada, toque duplo alterna o zoom
  const pts = new Map();
  let gest = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  const midpoint = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };
  const startPan = (p, moved = false) => ({ type: 'pan', x: p.x, y: p.y, lx: p.x, panX: view.panX, panY: view.panY, moved });

  ui.stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.vplay')) return;
    if (e.target.tagName === 'VIDEO' && e.clientY > ui.stage.getBoundingClientRect().bottom - 70) return; // controles do player
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      gest = startPan(pts.get(e.pointerId));
    } else if (pts.size === 2 && zoomable()) {
      const m = midpoint();
      const r = ui.stage.getBoundingClientRect();
      // Ponto da foto sob o centro da pinça, em coordenadas sem zoom
      gest = {
        type: 'pinch', d: m.d, z: view.zoom,
        qx: (m.x - r.left - r.width / 2 - view.panX) / view.zoom,
        qy: (m.y - r.top - r.height / 2 - view.panY) / view.zoom
      };
      const s = $('.slide', ui.stage);
      if (s) s.style.transform = '';
      ui.stage.classList.add('gesturing');
    }
  });

  ui.stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !gest) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gest.type === 'pinch' && pts.size >= 2) {
      const m = midpoint();
      const r = ui.stage.getBoundingClientRect();
      const z = Math.max(1, Math.min(MAX_ZOOM, gest.z * m.d / gest.d));
      view.zoom = z;
      view.panX = m.x - r.left - r.width / 2 - z * gest.qx;
      view.panY = m.y - r.top - r.height / 2 - z * gest.qy;
      clampPan();
      applyTransform();
      return;
    }
    if (gest.type !== 'pan') return;
    const dx = e.clientX - gest.x, dy = e.clientY - gest.y;
    gest.lx = e.clientX;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) gest.moved = true;
    if (view.zoom > 1) {
      ui.stage.classList.add('gesturing');
      view.panX = gest.panX + dx;
      view.panY = gest.panY + dy;
      clampPan();
      applyTransform();
    } else {
      const s = $('.slide', ui.stage);
      if (s) s.style.transform = `translateX(${dx}px)`;
    }
  });

  const endGesture = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!gest) return;
    if (gest.type === 'pinch') {
      if (pts.size === 1) gest = startPan([...pts.values()][0], true); // continua arrastando com o dedo que ficou
      else if (!pts.size) gest = null;
      if (view.zoom < 1.05) zoomAt(1, 0, 0);
      ui.stage.classList.remove('gesturing');
      renderViewerBar();
      return;
    }
    if (pts.size) return;
    ui.stage.classList.remove('gesturing');
    const dx = gest.lx - gest.x;
    const s = $('.slide', ui.stage);
    if (view.zoom === 1 && s) {
      s.style.transform = '';
      if (gest.moved && Math.abs(dx) > 70) go1(dx < 0 ? 1 : -1);
    }
    if (!gest.moved && e.type === 'pointerup' && zoomable()) {
      const now = Date.now();
      if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        zoomAt(view.zoom > 1 ? 1 : 2.5, e.clientX, e.clientY);
        renderViewerBar();
        lastTap.t = 0;
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }
    gest = null;
  };
  ui.stage.addEventListener('pointerup', endGesture);
  ui.stage.addEventListener('pointercancel', endGesture);

  $('#v-back').addEventListener('click', closeViewer);
  $('#v-rename').addEventListener('click', () => current() && renameItem(current()));
  const vFull = $('#v-full');
  vFull.hidden = IS_NATIVE || !document.documentElement.requestFullscreen;
  vFull.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await enterFullscreen();
    } catch (e) {
      toast('Tela cheia indisponível', 'Este navegador não permite tela cheia aqui.', 'i-warning');
    }
  });

  /* ---------- Renomear ---------- */

  async function renameItem(it) {
    const dot = it.name.lastIndexOf('.');
    const ext = dot > 0 ? it.name.slice(dot) : '';
    const base = dot > 0 ? it.name.slice(0, dot) : it.name;
    const raw = await promptBox({ title: 'Renomear', icon: 'i-rename', message: 'Novo nome do arquivo:', value: base, ok: 'Renomear' });
    if (raw == null) return;
    const clean = raw.trim().replace(/\s+/g, ' ');
    if (!clean || /[\\/:*?"<>|]/.test(clean)) {
      toast('Nome inválido', 'O nome não pode ficar vazio nem conter: \\ / : * ? " < > |', 'i-warning');
      return;
    }
    const name = clean + ext;
    if (name === it.name) return;
    if (it.src === 'device' && NM.canRename) {
      try {
        const got = await NM.rename(it, name);
        if (!got) return; // usuário recusou na confirmação do sistema
        it.name = got;
      } catch (e) {
        toast('Não foi possível renomear', 'O sistema não permitiu alterar este arquivo.', 'i-warning');
        return;
      }
    } else {
      it.name = name;
      if (it.src === 'device') it.alias = true; // iOS: apelido guardado pelo app
    }
    changed();
    await persist([it]);
    view.dirty = true;
    if (current() === it) updateViewerTitle(it);
    toast('Renomeado', `Agora se chama "${it.name}".`, 'i-rename');
  }

  /* ======================= Editor de imagem ======================= */

  const RATIOS = [['free', 'Livre'], ['orig', 'Original'], [1, '1:1'], [4 / 3, '4:3'], [3 / 4, '3:4'], [16 / 9, '16:9'], [9 / 16, '9:16'], [3 / 2, '3:2'], [2 / 3, '2:3']];
  const MAX_EDIT = 4096;   // maior lado carregado no editor (limite de memória do canvas)
  const MAX_OUT = 8192;
  const ed = { item: null, orig: null, src: null, crop: null, ratio: 'free', out: null, scale: 1, ox: 0, oy: 0 };
  const eui = {
    root: $('#editor'), stage: $('#e-stage'), canvas: $('#e-canvas'), crop: $('#e-crop'),
    ratios: $('#e-ratios'), size: $('#e-size'), meta: $('#e-meta'), save: $('#e-save')
  };

  const loadImage = (url) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });

  async function openEditor(it) {
    stopSlideshow();
    let url = fullSrc(it);
    try {
      if (!url) url = await NM.loadFull(it);
      const img = await loadImage(url);
      const k = Math.min(1, MAX_EDIT / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      Object.assign(ed, { item: it, orig: c, src: c, crop: { x: 0, y: 0, w: c.width, h: c.height }, ratio: 'free', out: null });
    } catch (e) {
      toast('Não foi possível editar', 'A imagem não pôde ser carregada.', 'i-warning');
      return;
    }
    eui.meta.textContent = displayName(it);
    eui.root.hidden = false;
    renderRatios();
    layoutEditor();
  }

  function closeEditor() {
    eui.root.hidden = true;
    eui.canvas.width = eui.canvas.height = 0;
    ed.orig = ed.src = null;
  }

  const ratioValue = () => (ed.ratio === 'free' ? null : ed.ratio === 'orig' ? ed.src.width / ed.src.height : ed.ratio);
  const outSize = () => ed.out || { w: Math.round(ed.crop.w), h: Math.round(ed.crop.h) };

  function renderRatios() {
    eui.ratios.innerHTML = '';
    RATIOS.forEach(([v, label]) => {
      eui.ratios.append(el('button', { class: 'chip' + (ed.ratio === v ? ' on' : ''), onclick: () => setRatio(v) }, label));
    });
  }

  // Maior área centralizada com a proporção escolhida
  function setRatio(v) {
    ed.ratio = v;
    const rv = ratioValue();
    if (rv) {
      const W = ed.src.width, H = ed.src.height;
      let w = W, h = W / rv;
      if (h > H) { h = H; w = H * rv; }
      ed.crop = { x: (W - w) / 2, y: (H - h) / 2, w, h };
    }
    ed.out = null;
    renderRatios();
    drawCrop();
  }

  function layoutEditor() {
    if (eui.root.hidden || !ed.src) return;
    const sw = eui.stage.clientWidth, sh = eui.stage.clientHeight, pad = 26;
    const s = Math.min((sw - pad * 2) / ed.src.width, (sh - pad * 2) / ed.src.height);
    const dw = ed.src.width * s, dh = ed.src.height * s;
    Object.assign(ed, { scale: s, ox: (sw - dw) / 2, oy: (sh - dh) / 2 });
    const dpr = window.devicePixelRatio || 1;
    const c = eui.canvas;
    c.width = Math.round(dw * dpr);
    c.height = Math.round(dh * dpr);
    Object.assign(c.style, { width: dw + 'px', height: dh + 'px', left: ed.ox + 'px', top: ed.oy + 'px' });
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(ed.src, 0, 0, c.width, c.height);
    drawCrop();
  }

  function drawCrop() {
    const { crop: k, scale: s } = ed;
    Object.assign(eui.crop.style, {
      left: ed.ox + k.x * s + 'px', top: ed.oy + k.y * s + 'px',
      width: k.w * s + 'px', height: k.h * s + 'px'
    });
    eui.crop.classList.toggle('locked', !!ratioValue());
    const o = outSize();
    eui.size.textContent = `${o.w} × ${o.h} px`;
  }

  // Move ou redimensiona o recorte (dx, dy em pixels da imagem) respeitando a proporção escolhida
  function resizeCrop(c, h, dx, dy) {
    const W = ed.src.width, H = ed.src.height;
    const MIN = Math.max(16, Math.min(W, H) * 0.04);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    if (h === 'move') return { x: clamp(c.x + dx, 0, W - c.w), y: clamp(c.y + dy, 0, H - c.h), w: c.w, h: c.h };
    let x1 = c.x, y1 = c.y, x2 = c.x + c.w, y2 = c.y + c.h;
    if (h.includes('w')) x1 = clamp(x1 + dx, 0, x2 - MIN);
    if (h.includes('e')) x2 = clamp(x2 + dx, x1 + MIN, W);
    if (h.includes('n')) y1 = clamp(y1 + dy, 0, y2 - MIN);
    if (h.includes('s')) y2 = clamp(y2 + dy, y1 + MIN, H);
    const rv = ratioValue();
    if (rv && h.length === 2) {
      // Canto com proporção fixa: o canto oposto fica parado
      const ax = h.includes('w') ? c.x + c.w : c.x;
      const ay = h.includes('n') ? c.y + c.h : c.y;
      let w = x2 - x1, hh = y2 - y1;
      if (Math.abs(dx) >= Math.abs(dy)) hh = w / rv; else w = hh * rv;
      const maxW = h.includes('w') ? ax : W - ax;
      const maxH = h.includes('n') ? ay : H - ay;
      if (w > maxW) { w = maxW; hh = w / rv; }
      if (hh > maxH) { hh = maxH; w = hh * rv; }
      if (w < MIN) { w = MIN; hh = w / rv; }
      x1 = h.includes('w') ? ax - w : ax;
      y1 = h.includes('n') ? ay - hh : ay;
      x2 = x1 + w;
      y2 = y1 + hh;
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  let cropDrag = null;
  eui.crop.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    eui.crop.setPointerCapture(e.pointerId);
    cropDrag = { h: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, c: { ...ed.crop } };
  });
  eui.crop.addEventListener('pointermove', (e) => {
    if (!cropDrag) return;
    ed.crop = resizeCrop(cropDrag.c, cropDrag.h, (e.clientX - cropDrag.x) / ed.scale, (e.clientY - cropDrag.y) / ed.scale);
    ed.out = null;
    drawCrop();
  });
  const endCropDrag = () => { cropDrag = null; };
  eui.crop.addEventListener('pointerup', endCropDrag);
  eui.crop.addEventListener('pointercancel', endCropDrag);

  // Gira 90° no sentido horário (a imagem e o recorte)
  function rotateEdit() {
    const s = ed.src;
    const c = document.createElement('canvas');
    c.width = s.height;
    c.height = s.width;
    const g = c.getContext('2d');
    g.translate(c.width, 0);
    g.rotate(Math.PI / 2);
    g.drawImage(s, 0, 0);
    const k = ed.crop;
    ed.crop = { x: s.height - (k.y + k.h), y: k.x, w: k.h, h: k.w };
    ed.src = c;
    if (typeof ed.ratio === 'number') {
      const match = RATIOS.find(([v]) => typeof v === 'number' && Math.abs(v - 1 / ed.ratio) < 0.01);
      ed.ratio = match ? match[0] : 'free';
    }
    if (ed.out) ed.out = { w: ed.out.h, h: ed.out.w };
    renderRatios();
    layoutEditor();
  }

  async function resizeDialog() {
    const cur = outSize();
    const base = { w: Math.round(ed.crop.w), h: Math.round(ed.crop.h) };
    const proportion = cur.w / cur.h;
    const body = el('div', {}, `
      <div class="num-row"><label>Largura</label><input class="textbox" type="number" min="1" max="${MAX_OUT}" inputmode="numeric"><span>px</span></div>
      <div class="num-row"><label>Altura</label><input class="textbox" type="number" min="1" max="${MAX_OUT}" inputmode="numeric"><span>px</span></div>
      <label class="check-row"><input type="checkbox" checked>Manter proporção</label>
      <div class="pct-row"></div>`);
    const [wi, hi] = body.querySelectorAll('.textbox');
    const lock = body.querySelector('input[type="checkbox"]');
    wi.value = cur.w;
    hi.value = cur.h;
    wi.addEventListener('input', () => { if (lock.checked && +wi.value) hi.value = Math.max(1, Math.round(wi.value / proportion)); });
    hi.addEventListener('input', () => { if (lock.checked && +hi.value) wi.value = Math.max(1, Math.round(hi.value * proportion)); });
    [25, 50, 75, 100].forEach((p) => {
      $('.pct-row', body).append(el('button', {
        class: 'chip', type: 'button',
        onclick: () => { wi.value = Math.max(1, Math.round(base.w * p / 100)); hi.value = Math.max(1, Math.round(base.h * p / 100)); }
      }, p + '%'));
    });
    const d = dialog({ title: 'Redimensionar', icon: 'i-resize', message: 'Novo tamanho da imagem:', body, buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancelar', value: null }] });
    if ((await d.promise) !== 'ok') return;
    const w = Math.round(+wi.value), h = Math.round(+hi.value);
    if (!(w >= 1 && h >= 1 && w <= MAX_OUT && h <= MAX_OUT)) {
      toast('Tamanho inválido', `Use valores entre 1 e ${MAX_OUT} px.`, 'i-warning');
      return;
    }
    ed.out = { w, h };
    drawCrop();
  }

  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

  async function saveEdit() {
    if (!ed.src || eui.save.disabled) return; // evita salvar duas vezes
    eui.save.disabled = true;
    toast('Salvando…', 'Criando uma cópia editada.', 'i-crop', 0);
    try {
      const it = ed.item;
      const o = outSize();
      const c = document.createElement('canvas');
      c.width = o.w;
      c.height = o.h;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(ed.src, ed.crop.x, ed.crop.y, ed.crop.w, ed.crop.h, 0, 0, o.w, o.h);
      const png = /png/i.test(it.mime || '') || /\.png$/i.test(it.name);
      const mime = png ? 'image/png' : 'image/jpeg';
      const blob = await new Promise((r) => c.toBlob(r, mime, 0.92));
      c.width = c.height = 0;
      if (!blob) {
        toast('Não foi possível salvar', 'A imagem ficou grande demais para este aparelho.', 'i-warning');
        return;
      }
      const base = (it.name || 'imagem').replace(/\.[^.]+$/, '');
      const name = `${base}_editada.${png ? 'png' : 'jpg'}`;
      if (it.src === 'device') {
        const saved = await NM.save(await blobToBase64(blob), name, mime, it);
        closeEditor();
        await rescan(true, true);
        toast('Cópia salva', `"${saved.name || name}" foi adicionada à galeria.`, 'i-crop');
      } else {
        closeEditor();
        await importFiles([new File([blob], name, { type: mime, lastModified: Date.now() })], { album: it.album, dateFn: () => Date.now() });
      }
      view.dirty = true;
    } catch (e) {
      toast('Não foi possível salvar', 'O sistema não permitiu gravar a cópia.', 'i-warning');
    } finally {
      eui.save.disabled = false;
    }
  }

  $('#e-back').addEventListener('click', closeEditor);
  $('#e-save').addEventListener('click', saveEdit);
  $('#e-rotate').addEventListener('click', rotateEdit);
  $('#e-resize').addEventListener('click', resizeDialog);
  $('#e-reset').addEventListener('click', () => {
    Object.assign(ed, { src: ed.orig, crop: { x: 0, y: 0, w: ed.orig.width, h: ed.orig.height }, ratio: 'free', out: null });
    renderRatios();
    layoutEditor();
  });
  window.addEventListener('resize', () => { layoutEditor(); clampPan(); applyTransform(); });

  /* ======================= Tela cheia e orientação ======================= */

  function lockPortrait() {
    try {
      const o = screen.orientation;
      if (o && o.lock) o.lock('portrait-primary').catch(() => {});
    } catch (e) { /* não suportado */ }
  }

  async function enterFullscreen() {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    lockPortrait();
  }

  /* ======================= Voltar (Android) / Esc ======================= */

  function handleBack() {
    if (!ui.modal.hidden) { state.modalCancel && state.modalCancel(); return true; }
    if (!ui.startMenu.hidden) { closeStart(); return true; }
    if (!eui.root.hidden) { closeEditor(); return true; }
    if (!ui.viewer.hidden) { IS_NATIVE ? hideViewer() : closeViewer(); return true; }
    if (state.selecting) {
      const back = state.pickFor;
      exitSelection();
      if (back) go(`#/albuns/p/${encodeURIComponent(back)}`);
      return true;
    }
    if (state.route.album || state.route.folder) { goUp(); return true; }
    if (IS_NATIVE && state.route.tab !== 'geral') { go('#/geral'); return true; }
    return false;
  }

  if (IS_NATIVE) NM.onBack(() => { if (!handleBack()) NM.exit(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { handleBack(); return; }
    if (!ui.modal.hidden || ui.viewer.hidden || !eui.root.hidden) return;
    if (e.key === 'ArrowRight') go1(1);
    else if (e.key === 'ArrowLeft') go1(-1);
  });

  /* ======================= Diálogos e notificações ======================= */

  // Caixa de diálogo genérica; resolve com o valor do botão (ou null ao cancelar)
  function dialog({ title, icon: ico = 'i-info', message = '', detail = '', body = null, buttons }) {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    const close = (v) => {
      if (ui.modal.hidden) return;
      ui.modal.hidden = true;
      ui.modal.innerHTML = '';
      state.modalCancel = null;
      resolve(v);
    };
    ui.modal.innerHTML = '';
    const dlg = el('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title }, `
      <div class="dialog-title"><img src="assets/icon-64.png" alt="">${esc(title)}</div>
      <div class="dialog-body">${icon(ico)}<div>${message ? `<p>${esc(message)}</p>` : ''}${detail ? `<p>${esc(detail)}</p>` : ''}</div></div>`);
    if (body) $('.dialog-body > div', dlg).append(body);
    const actions = el('div', { class: 'dialog-actions' });
    buttons.forEach((b) => actions.append(el('button', { class: 'btn' + (b.primary ? ' primary' : ''), onclick: () => close(b.value) }, esc(b.label))));
    dlg.append(actions);
    ui.modal.append(dlg);
    ui.modal.onclick = (e) => { if (e.target === ui.modal) close(null); };
    state.modalCancel = () => close(null);
    ui.modal.hidden = false;
    const focus = $('input', dlg) || $('.btn.primary', dlg);
    if (focus) focus.focus();
    return { promise, close };
  }

  async function confirmBox({ title, icon: ico = 'i-warning', message, detail = '', ok = 'Sim', cancel = 'Não' }) {
    const buttons = [{ label: ok, value: true, primary: true }];
    if (cancel) buttons.push({ label: cancel, value: false });
    return !!(await dialog({ title, icon: ico, message, detail, buttons }).promise);
  }

  async function promptBox({ title, message, value = '', ok = 'OK', icon: ico = 'i-folder' }) {
    const input = el('input', { class: 'textbox', type: 'text', value, maxlength: 120, autocomplete: 'off', enterkeyhint: 'done' });
    const d = dialog({ title, icon: ico, message, body: input, buttons: [{ label: ok, value: 'ok', primary: true }, { label: 'Cancelar', value: null }] });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') d.close('ok'); });
    setTimeout(() => input.select(), 30);
    return (await d.promise) === 'ok' ? input.value : null;
  }

  let balloonTimer = null;
  function toast(title, text, ico = 'i-info', ms = 3200) {
    clearTimeout(balloonTimer);
    ui.balloon.innerHTML = `${icon(ico)}<div><b>${esc(title)}</b>${esc(text)}</div>`;
    ui.balloon.hidden = false;
    if (ms) balloonTimer = setTimeout(() => (ui.balloon.hidden = true), ms);
  }
  ui.balloon.addEventListener('click', () => (ui.balloon.hidden = true));

  /* ======================= Menu Iniciar e tema ======================= */

  function closeStart() {
    ui.startMenu.hidden = true;
    ui.start.setAttribute('aria-expanded', 'false');
  }

  ui.start.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = ui.startMenu.hidden;
    ui.startMenu.hidden = !open;
    ui.start.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', (e) => {
    if (!ui.startMenu.hidden && !ui.startMenu.contains(e.target)) closeStart();
  });

  ui.startMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return closeStart();
    closeStart();
    const actions = {
      refresh: () => rescan(true),
      'import-files': () => ui.fileInput.click(),
      'import-folder': () => ui.folderInput.click(),
      'new-folder': async () => {
        const f = await newFolder();
        if (f) go(`#/albuns/p/${encodeURIComponent(f.id)}`);
      },
      samples: loadSamples,
      theme: toggleTheme,
      about: showAbout
    };
    actions[b.dataset.action] && actions[b.dataset.action]();
  });

  function showAbout() {
    const body = el('div', { class: 'about' }, `
      <p>${IS_NATIVE
        ? 'Galeria de fotos, vídeos e GIFs inspirada no Windows XP, Vista e 7. As mídias são lidas direto da galeria do aparelho.'
        : 'Galeria de fotos, vídeos e GIFs inspirada no Windows XP, Vista e 7. Seus arquivos ficam salvos apenas neste dispositivo.'}</p>
      <div class="about-oss">
        <b>Código aberto</b>
        <span>Todo o código do FoldAero é público. Qualquer pessoa pode conferir que o app não envia suas fotos e vídeos para lugar nenhum: tudo fica no seu aparelho.</span>
      </div>
      <a class="btn github" href="${GITHUB_URL}" target="_blank" rel="noopener">${icon('i-github')}PedroPaulo00 no GitHub</a>`);
    dialog({
      title: 'Sobre o FoldAero',
      icon: 'i-info',
      message: `FoldAero — versão ${APP_VERSION}`,
      detail: 'Um app da AquariusFresh Labs.',
      body,
      buttons: [{ label: 'OK', value: true, primary: true }]
    });
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('dv-theme', next);
    $('meta[name="theme-color"]').setAttribute('content', next === 'dark' ? '#000000' : '#1c6fb8');
  }
  $('#btn-theme').addEventListener('click', toggleTheme);

  ui.back.addEventListener('click', goUp);

  /* ======================= Entradas de arquivo (navegador) ======================= */

  ui.fileInput.addEventListener('change', () => {
    const files = [...ui.fileInput.files];
    ui.fileInput.value = '';
    if (files.length) importFiles(files, { album: state.route.album || undefined, folder: state.route.folder || undefined });
  });
  ui.folderInput.addEventListener('change', () => {
    const files = [...ui.folderInput.files];
    ui.folderInput.value = '';
    if (files.length) importFiles(files);
  });

  /* ======================= Relógio da bandeja ======================= */

  const clock = $('#clock');
  const tick = () => {
    clock.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  };
  tick();

  /* ======================= Inicialização ======================= */

  async function init() {
    document.documentElement.style.setProperty('--cols', state.cols);
    $('meta[name="theme-color"]').setAttribute('content', document.documentElement.dataset.theme === 'dark' ? '#000000' : '#1c6fb8');
    if (!location.hash) history.replaceState(null, '', '#/geral');
    state.route = parseRoute();
    render();

    // Banco local e galeria do aparelho são lidos em paralelo
    const dbJob = Promise.all([DB.all('media'), DB.all('meta'), DB.all('folders')])
      .then(([media, meta, folders]) => {
        state.meta = new Map(meta.map((m) => [m.id, m]));
        state.folders = folders;
        setItems(media.map((i) => Object.assign(i, { src: 'local' })));
      })
      .catch(() => toast('Armazenamento indisponível', 'Não foi possível abrir o banco de dados local. As alterações não serão salvas.', 'i-warning', 6000));

    let rest = null;
    if (IS_NATIVE) {
      try {
        await NM.init();
        state.access = await NM.status();
        // Primeira abertura: já pede o acesso às fotos
        if (state.access !== 'granted' && state.access !== 'limited' && !store.get('dv-asked')) {
          store.set('dv-asked', '1');
          state.askedAccess = true;
          state.access = await NM.request();
        }
        if (state.access === 'granted' || state.access === 'limited') {
          // Fase 1: só as mídias mais recentes, para a primeira tela aparecer logo
          const [first] = await Promise.all([NM.list(FIRST_PAGE), dbJob]);
          applyDevice(first.items, first.complete);
          // Fase 2: o resto da galeria chega em segundo plano
          if (!first.complete) rest = NM.list();
        }
      } catch (e) {
        toast('Falha ao ler a galeria', 'Não foi possível acessar as fotos do aparelho.', 'i-warning', 5000);
      }
    }
    await dbJob;
    state.loading = false;
    state.forceRoute = true;
    onRoute();

    if (rest) {
      try {
        const full = await rest;
        applyDevice(full.items, true);
        render({ keepScroll: true });
      } catch (e) {
        toast('Falha ao ler a galeria', 'Parte das mídias não pôde ser carregada.', 'i-warning', 5000);
      }
    }
    const v = state.version;
    await purgeExpired().catch(() => {});
    if (state.version !== v) render({ keepScroll: true });

    // O bloqueio de orientação só é aceito após um gesto do usuário (ou em PWA instalado)
    lockPortrait();
    document.addEventListener('pointerdown', lockPortrait, { once: true });

    if (!IS_NATIVE && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
