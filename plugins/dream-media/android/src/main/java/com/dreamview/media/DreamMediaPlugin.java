package com.dreamview.media;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.app.RecoverableSecurityException;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.IntentSender;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Size;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.IntConsumer;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Galeria nativa do FoldAero: lista fotos/vídeos do MediaStore, serve miniaturas e
 * originais para a WebView, renomeia, salva cópias editadas, exclui com a confirmação do
 * sistema e abre vídeos no player nativo (Media3).
 */
@CapacitorPlugin(
    name = "DreamMedia",
    permissions = {
        @Permission(alias = "legacy", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "legacyWrite", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }),
        @Permission(alias = "media", strings = { "android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO" }),
        @Permission(alias = "partial", strings = { "android.permission.READ_MEDIA_VISUAL_USER_SELECTED" })
    }
)
public class DreamMediaPlugin extends Plugin {

    static final String THUMB_PREFIX = "_dv_thumb";
    static final String MEDIA_PREFIX = "_dv_media";
    private static final int THUMB_SIZE = 320;
    private static final int FULL_MAX = 2560;

    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private ActivityResultLauncher<IntentSenderRequest> senderLauncher;
    private IntConsumer pendingResult;

    @Override
    public void load() {
        bridge.setWebViewClient(new DreamWebViewClient(bridge, this));
        senderLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            (result) -> {
                IntConsumer cb = pendingResult;
                pendingResult = null;
                if (cb != null) cb.accept(result.getResultCode());
            }
        );
    }

    /** Abre uma confirmação do sistema (exclusão/escrita) e devolve o resultado ao callback. */
    private void askSystem(IntentSender sender, IntConsumer onResult) {
        bridge.executeOnMainThread(() -> {
            pendingResult = onResult;
            senderLauncher.launch(new IntentSenderRequest.Builder(sender).build());
        });
    }

    /* ======================= Permissões ======================= */

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private String accessStatus() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (granted("android.permission.READ_MEDIA_IMAGES") || granted("android.permission.READ_MEDIA_VIDEO")) return "granted";
            if (Build.VERSION.SDK_INT >= 34 && granted("android.permission.READ_MEDIA_VISUAL_USER_SELECTED")) return "limited";
            return "denied";
        }
        return granted(Manifest.permission.READ_EXTERNAL_STORAGE) ? "granted" : "denied";
    }

    private boolean hasAccess() {
        return !"denied".equals(accessStatus());
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("platform", "android");
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("systemDeleteConfirm", Build.VERSION.SDK_INT >= 30);
        r.put("canRename", true);
        call.resolve(r);
    }

    @PluginMethod
    public void checkAccess(PluginCall call) {
        JSObject r = new JSObject();
        r.put("status", accessStatus());
        call.resolve(r);
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if ("granted".equals(accessStatus())) {
            checkAccess(call);
            return;
        }
        String[] aliases;
        if (Build.VERSION.SDK_INT >= 34) aliases = new String[] { "media", "partial" };
        else if (Build.VERSION.SDK_INT >= 33) aliases = new String[] { "media" };
        else if (Build.VERSION.SDK_INT <= 28) aliases = new String[] { "legacy", "legacyWrite" };
        else aliases = new String[] { "legacy" };
        requestPermissionForAliases(aliases, call, "accessCallback");
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        checkAccess(call);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /* ======================= Listagem ======================= */

    /** {@code limit} > 0 devolve só os itens mais recentes (primeira tela rápida). */
    @PluginMethod
    public void list(PluginCall call) {
        if (!hasAccess()) {
            call.reject("Sem permissão para acessar a galeria", "DENIED");
            return;
        }
        int limit = call.getInt("limit", 0);
        executor.execute(() -> {
            try {
                List<JSObject> rows = new ArrayList<>();
                query(false, limit, rows);
                query(true, limit, rows);
                if (limit > 0 && rows.size() > limit) {
                    Collections.sort(rows, (a, b) -> Long.compare(b.optLong("mod"), a.optLong("mod")));
                    rows = rows.subList(0, limit);
                }
                JSArray items = new JSArray();
                for (JSObject o : rows) items.put(o);
                JSObject r = new JSObject();
                r.put("items", items);
                r.put("complete", limit <= 0);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Falha ao ler a galeria: " + e.getMessage());
            }
        });
    }

    private static Uri collection(boolean video) {
        if (Build.VERSION.SDK_INT >= 29) {
            return video
                ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
                : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
        }
        return video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
    }

    static Uri contentUri(String type, long id) {
        return ContentUris.withAppendedId(collection("video".equals(type)), id);
    }

    private Cursor sortedQuery(Uri uri, String[] projection, int limit) {
        ContentResolver cr = getContext().getContentResolver();
        if (limit <= 0) return cr.query(uri, projection, null, null, null);
        if (Build.VERSION.SDK_INT >= 30) {
            Bundle args = new Bundle();
            args.putStringArray(ContentResolver.QUERY_ARG_SORT_COLUMNS, new String[] { "date_modified" });
            args.putInt(ContentResolver.QUERY_ARG_SORT_DIRECTION, ContentResolver.QUERY_SORT_DIRECTION_DESCENDING);
            args.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);
            return cr.query(uri, projection, args, null);
        }
        return cr.query(uri, projection, null, null, "date_modified DESC LIMIT " + limit);
    }

    private void query(boolean video, int limit, List<JSObject> out) {
        String[] projection = video
            ? new String[] { "_id", "_display_name", "mime_type", "datetaken", "date_added", "date_modified", "bucket_display_name", "duration" }
            : new String[] { "_id", "_display_name", "mime_type", "datetaken", "date_added", "date_modified", "bucket_display_name" };
        try (Cursor c = sortedQuery(collection(video), projection, limit)) {
            if (c == null) return;
            while (c.moveToNext()) {
                long id = c.getLong(0);
                String mime = c.getString(2);
                long taken = c.getLong(3);
                long added = c.getLong(4);
                long modified = c.getLong(5);
                String type = video ? "video" : ("image/gif".equalsIgnoreCase(mime) ? "gif" : "image");

                JSObject o = new JSObject();
                o.put("id", String.valueOf(id));
                o.put("type", type);
                o.put("mime", mime == null ? "" : mime);
                o.put("name", c.getString(1) == null ? "" : c.getString(1));
                o.put("taken", Math.max(0, taken));
                o.put("date", taken > 0 ? taken : (modified > 0 ? modified * 1000 : added * 1000));
                o.put("mod", modified);
                o.put("album", c.getString(6) == null ? "" : c.getString(6));
                if (video) o.put("duration", c.getLong(7) / 1000.0);
                out.add(o);
            }
        }
    }

    /* ======================= Player de vídeo nativo ======================= */

    @PluginMethod
    public void playVideo(PluginCall call) {
        try {
            Uri uri = contentUri("video", Long.parseLong(call.getString("id", "")));
            Intent intent = new Intent(getContext(), PlayerActivity.class);
            intent.setData(uri);
            intent.putExtra(PlayerActivity.EXTRA_TITLE, call.getString("title", ""));
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Não foi possível abrir o vídeo");
        }
    }

    /* ======================= Renomear ======================= */

    @PluginMethod
    public void rename(PluginCall call) {
        String name = call.getString("name", "").trim();
        if (name.isEmpty() || name.contains("/")) {
            call.reject("Nome inválido");
            return;
        }
        Uri uri;
        try {
            uri = contentUri(call.getString("type", "image"), Long.parseLong(call.getString("id", "")));
        } catch (Exception e) {
            call.reject("Item inválido");
            return;
        }
        if (Build.VERSION.SDK_INT >= 30) {
            // Arquivos de outros apps exigem a autorização do usuário para alteração
            PendingIntent pi = MediaStore.createWriteRequest(getContext().getContentResolver(), Collections.singletonList(uri));
            askSystem(pi.getIntentSender(), (code) -> {
                if (code == Activity.RESULT_OK) executor.execute(() -> doRename(call, uri, name));
                else resolveRenamed(call, null);
            });
            return;
        }
        executor.execute(() -> doRename(call, uri, name));
    }

    @SuppressWarnings("deprecation")
    private void doRename(PluginCall call, Uri uri, String name) {
        ContentResolver cr = getContext().getContentResolver();
        try {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            if (Build.VERSION.SDK_INT <= 28) {
                // Antes do Android 10 o arquivo precisa ser renomeado no disco
                String path = null;
                try (Cursor c = cr.query(uri, new String[] { MediaStore.MediaColumns.DATA }, null, null, null)) {
                    if (c != null && c.moveToFirst()) path = c.getString(0);
                }
                if (path == null) throw new IOException("caminho desconhecido");
                File from = new File(path);
                File to = new File(from.getParentFile(), name);
                if (to.exists()) throw new IOException("já existe um arquivo com esse nome");
                if (!from.renameTo(to)) throw new IOException("falha ao renomear");
                v.put(MediaStore.MediaColumns.DATA, to.getAbsolutePath());
            }
            cr.update(uri, v, null, null);
            resolveRenamed(call, currentName(uri, name));
        } catch (SecurityException e) {
            if (Build.VERSION.SDK_INT == 29 && e instanceof RecoverableSecurityException) {
                IntentSender sender = ((RecoverableSecurityException) e).getUserAction().getActionIntent().getIntentSender();
                askSystem(sender, (code) -> {
                    if (code == Activity.RESULT_OK) executor.execute(() -> doRename(call, uri, name));
                    else resolveRenamed(call, null);
                });
                return;
            }
            call.reject("Sem permissão para renomear", "DENIED");
        } catch (Exception e) {
            call.reject("Não foi possível renomear: " + e.getMessage());
        }
    }

    private String currentName(Uri uri, String fallback) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception ignored) {
            // mantém o nome pedido
        }
        return fallback;
    }

    private void resolveRenamed(PluginCall call, String name) {
        JSObject r = new JSObject();
        r.put("renamed", name != null);
        if (name != null) r.put("name", name);
        call.resolve(r);
    }

    /* ======================= Salvar cópia editada ======================= */

    @PluginMethod
    public void save(PluginCall call) {
        String data = call.getString("data");
        String name = call.getString("name", "FoldAero.jpg");
        String mime = call.getString("mime", "image/jpeg");
        String near = call.getString("near"); // id do original, para salvar na mesma pasta
        if (data == null) {
            call.reject("Imagem vazia");
            return;
        }
        executor.execute(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                JSObject r = Build.VERSION.SDK_INT >= 29 ? saveModern(bytes, name, mime, near) : saveLegacy(bytes, name, mime);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Não foi possível salvar: " + e.getMessage());
            }
        });
    }

    private String relativePathOf(String id) {
        if (id == null || Build.VERSION.SDK_INT < 29) return null;
        try (Cursor c = getContext().getContentResolver().query(contentUri("image", Long.parseLong(id)), new String[] { "relative_path" }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String p = c.getString(0);
                // A coleção de imagens só aceita DCIM/ e Pictures/
                if (p != null && (p.startsWith("DCIM/") || p.startsWith("Pictures/"))) return p;
            }
        } catch (Exception ignored) {
            // usa a pasta padrão
        }
        return null;
    }

    private JSObject saveModern(byte[] bytes, String name, String mime, String near) throws IOException {
        ContentResolver cr = getContext().getContentResolver();
        String rel = relativePathOf(near);
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel != null ? rel : Environment.DIRECTORY_PICTURES + "/FoldAero");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        v.put("datetaken", System.currentTimeMillis());
        Uri uri = cr.insert(collection(false), v);
        if (uri == null) throw new IOException("MediaStore recusou o arquivo");
        try (OutputStream out = cr.openOutputStream(uri)) {
            if (out == null) throw new IOException("sem acesso ao arquivo");
            out.write(bytes);
        } catch (IOException e) {
            cr.delete(uri, null, null);
            throw e;
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(uri, done, null, null);
        JSObject r = new JSObject();
        r.put("id", String.valueOf(ContentUris.parseId(uri)));
        r.put("name", currentName(uri, name));
        return r;
    }

    @SuppressWarnings("deprecation")
    private JSObject saveLegacy(byte[] bytes, String name, String mime) throws IOException {
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "FoldAero");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("sem permissão de escrita");
        File file = new File(dir, name);
        int k = 1;
        String base = name.replaceFirst("\\.[^.]+$", "");
        String ext = name.substring(base.length());
        while (file.exists()) file = new File(dir, base + " (" + k++ + ")" + ext);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
        MediaScannerConnection.scanFile(getContext(), new String[] { file.getAbsolutePath() }, new String[] { mime }, null);
        JSObject r = new JSObject();
        r.put("name", file.getName());
        return r;
    }

    /* ======================= Exclusão ======================= */

    @PluginMethod
    public void delete(PluginCall call) {
        JSArray arr = call.getArray("items");
        List<Uri> uris = new ArrayList<>();
        try {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                uris.add(contentUri(o.getString("type"), Long.parseLong(o.getString("id"))));
            }
        } catch (JSONException | NumberFormatException e) {
            call.reject("Itens inválidos");
            return;
        }
        if (uris.isEmpty()) {
            resolveDeleted(call, true);
            return;
        }
        if (Build.VERSION.SDK_INT >= 30) {
            PendingIntent pi = MediaStore.createDeleteRequest(getContext().getContentResolver(), uris);
            askSystem(pi.getIntentSender(), (code) -> resolveDeleted(call, code == Activity.RESULT_OK));
            return;
        }
        deleteDirect(call, uris);
    }

    private void deleteDirect(PluginCall call, List<Uri> uris) {
        executor.execute(() -> {
            ContentResolver cr = getContext().getContentResolver();
            for (int i = 0; i < uris.size(); i++) {
                try {
                    cr.delete(uris.get(i), null, null);
                } catch (SecurityException e) {
                    // Android 10: o sistema precisa confirmar arquivos criados por outros apps
                    if (Build.VERSION.SDK_INT == 29 && e instanceof RecoverableSecurityException) {
                        IntentSender sender = ((RecoverableSecurityException) e).getUserAction().getActionIntent().getIntentSender();
                        List<Uri> rest = new ArrayList<>(uris.subList(i, uris.size()));
                        askSystem(sender, (code) -> {
                            if (code == Activity.RESULT_OK) deleteDirect(call, rest);
                            else resolveDeleted(call, false);
                        });
                        return;
                    }
                    call.reject("Sem permissão para excluir", "DENIED");
                    return;
                }
            }
            resolveDeleted(call, true);
        });
    }

    private void resolveDeleted(PluginCall call, boolean deleted) {
        JSObject r = new JSObject();
        r.put("deleted", deleted);
        call.resolve(r);
    }

    /* ======================= Servidor de mídia para a WebView ======================= */

    /** Atende /_dv_thumb/{tipo}/{id}?m={modificado} e /_dv_media/{tipo}/{id}[?jpeg=1]. */
    WebResourceResponse serve(WebResourceRequest request) {
        Uri url = request.getUrl();
        List<String> seg = url.getPathSegments();
        if (seg.size() < 3) return null;
        String kind = seg.get(0);
        if (!THUMB_PREFIX.equals(kind) && !MEDIA_PREFIX.equals(kind)) return null;
        if (!hasAccess()) return status(403, "Forbidden");
        try {
            String type = seg.get(1);
            long id = Long.parseLong(seg.get(2));
            Uri uri = contentUri(type, id);
            String mod = url.getQueryParameter("m");
            if (THUMB_PREFIX.equals(kind)) {
                int size = THUMB_SIZE;
                String s = url.getQueryParameter("s");
                if (s != null) size = Math.max(96, Math.min(1440, Integer.parseInt(s)));
                return serveThumb(uri, type, id, mod == null ? "0" : mod, size);
            }
            if ("1".equals(url.getQueryParameter("jpeg"))) return serveConverted(uri, id, mod == null ? "0" : mod);
            return serveMedia(uri, request.getRequestHeaders());
        } catch (Exception e) {
            return status(404, "Not Found");
        }
    }

    private WebResourceResponse serveThumb(Uri uri, String type, long id, String mod, int size) throws IOException {
        File dir = new File(getContext().getCacheDir(), "dv-thumbs");
        File file = new File(dir, type + "_" + id + "_" + mod + "_" + size + ".jpg");
        if (!file.exists()) {
            Bitmap bmp = loadThumbnail(uri, type, id, size);
            if (bmp == null) return status(404, "Not Found");
            writeJpeg(bmp, dir, file, 78);
            bmp.recycle();
        }
        return fileResponse(file, "image/jpeg");
    }

    @SuppressWarnings("deprecation")
    private Bitmap loadThumbnail(Uri uri, String type, long id, int size) {
        ContentResolver cr = getContext().getContentResolver();
        try {
            if (Build.VERSION.SDK_INT >= 29) return cr.loadThumbnail(uri, new Size(size, size), null);
            if ("video".equals(type)) return MediaStore.Video.Thumbnails.getThumbnail(cr, id, MediaStore.Video.Thumbnails.MINI_KIND, null);
            return MediaStore.Images.Thumbnails.getThumbnail(cr, id, MediaStore.Images.Thumbnails.MINI_KIND, null);
        } catch (Exception e) {
            return null;
        }
    }

    /** HEIC/HEIF não abre na WebView: converte para JPEG (cacheado). */
    private WebResourceResponse serveConverted(Uri uri, long id, String mod) throws IOException {
        if (Build.VERSION.SDK_INT < 28) return serveMedia(uri, new HashMap<>());
        File dir = new File(getContext().getCacheDir(), "dv-full");
        File file = new File(dir, id + "_" + mod + ".jpg");
        if (!file.exists()) {
            ImageDecoder.Source source = ImageDecoder.createSource(getContext().getContentResolver(), uri);
            Bitmap bmp = ImageDecoder.decodeBitmap(source, (decoder, info, src) -> {
                int w = info.getSize().getWidth(), h = info.getSize().getHeight();
                float k = Math.min(1f, (float) FULL_MAX / Math.max(w, h));
                decoder.setTargetSize(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
            });
            writeJpeg(bmp, dir, file, 90);
            bmp.recycle();
        }
        return fileResponse(file, "image/jpeg");
    }

    private static void writeJpeg(Bitmap bmp, File dir, File file, int quality) throws IOException {
        if (!dir.exists() && !dir.mkdirs() && !dir.exists()) throw new IOException("cache indisponível");
        File tmp = new File(dir, file.getName() + "." + Thread.currentThread().getId() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            bmp.compress(Bitmap.CompressFormat.JPEG, quality, out);
        }
        if (!tmp.renameTo(file)) tmp.delete();
    }

    private WebResourceResponse fileResponse(File file, String mime) throws IOException {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "max-age=31536000, immutable");
        headers.put("Content-Length", String.valueOf(file.length()));
        return new WebResourceResponse(mime, null, 200, "OK", headers, new FileInputStream(file));
    }

    private WebResourceResponse serveMedia(Uri uri, Map<String, String> requestHeaders) throws IOException {
        ContentResolver cr = getContext().getContentResolver();
        String mime = cr.getType(uri);
        if (mime == null) mime = "application/octet-stream";
        AssetFileDescriptor afd = cr.openAssetFileDescriptor(uri, "r");
        if (afd == null) return status(404, "Not Found");
        long total = afd.getLength();
        if (total < 0) total = afd.getParcelFileDescriptor().getStatSize();
        InputStream in = afd.createInputStream();

        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "no-cache");

        String range = null;
        for (Map.Entry<String, String> h : requestHeaders.entrySet()) {
            if ("range".equalsIgnoreCase(h.getKey())) range = h.getValue();
        }
        if (range != null && range.startsWith("bytes=") && total > 0) {
            String[] parts = range.substring(6).split(",")[0].split("-", 2);
            long start, end;
            if (parts[0].trim().isEmpty()) {
                // sufixo: "bytes=-500" = últimos 500 bytes
                start = Math.max(0, total - Long.parseLong(parts[1].trim()));
                end = total - 1;
            } else {
                start = Long.parseLong(parts[0].trim());
                end = parts.length > 1 && !parts[1].trim().isEmpty() ? Long.parseLong(parts[1].trim()) : total - 1;
            }
            end = Math.min(end, total - 1);
            if (start > end) {
                in.close();
                headers.put("Content-Range", "bytes */" + total);
                return new WebResourceResponse(mime, null, 416, "Range Not Satisfiable", headers, new ByteArrayInputStream(new byte[0]));
            }
            skipFully(in, start);
            long length = end - start + 1;
            headers.put("Content-Range", "bytes " + start + "-" + end + "/" + total);
            headers.put("Content-Length", String.valueOf(length));
            return new WebResourceResponse(mime, null, 206, "Partial Content", headers, new BoundedInputStream(in, length));
        }
        if (total >= 0) headers.put("Content-Length", String.valueOf(total));
        return new WebResourceResponse(mime, null, 200, "OK", headers, in);
    }

    private static void skipFully(InputStream in, long n) throws IOException {
        while (n > 0) {
            long skipped = in.skip(n);
            if (skipped <= 0) {
                if (in.read() < 0) return;
                skipped = 1;
            }
            n -= skipped;
        }
    }

    private static WebResourceResponse status(int code, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    /** Limita a leitura a {@code remaining} bytes (resposta 206). */
    private static final class BoundedInputStream extends InputStream {

        private final InputStream in;
        private long remaining;

        BoundedInputStream(InputStream in, long remaining) {
            this.in = in;
            this.remaining = remaining;
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) return -1;
            int b = in.read();
            if (b >= 0) remaining--;
            return b;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            if (remaining <= 0) return -1;
            int n = in.read(buf, off, (int) Math.min(len, remaining));
            if (n > 0) remaining -= n;
            return n;
        }

        @Override
        public int available() throws IOException {
            return (int) Math.min(in.available(), remaining);
        }

        @Override
        public void close() throws IOException {
            in.close();
        }
    }
}
