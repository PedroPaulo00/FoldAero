package com.dreamview.media;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

/** Intercepta as rotas de mídia do FoldAero e deixa o resto com o servidor do Capacitor. */
class DreamWebViewClient extends BridgeWebViewClient {

    private final DreamMediaPlugin plugin;

    DreamWebViewClient(Bridge bridge, DreamMediaPlugin plugin) {
        super(bridge);
        this.plugin = plugin;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String path = request.getUrl().getPath();
        if (path != null && path.startsWith("/_dv_")) {
            WebResourceResponse response = plugin.serve(request);
            if (response != null) return response;
        }
        return super.shouldInterceptRequest(view, request);
    }
}
