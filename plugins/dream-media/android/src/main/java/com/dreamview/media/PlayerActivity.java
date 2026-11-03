package com.dreamview.media;

import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.ImageButton;
import android.widget.SeekBar;
import android.widget.TextView;
import androidx.annotation.OptIn;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.res.ResourcesCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;
import java.util.Locale;

/** Player de vídeo nativo (Media3) com controles no estilo do Windows Media Player / Aero. */
public class PlayerActivity extends AppCompatActivity {

    static final String EXTRA_TITLE = "title";
    private static final String STATE_POSITION = "position";
    private static final long SEEK_STEP_MS = 10_000;
    private static final long HIDE_DELAY_MS = 3_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable ticker = this::updateProgress;
    private final Runnable autoHide = () -> setControlsVisible(false);

    private ExoPlayer player;
    private PlayerView videoView;
    private View top, bottom;
    private ImageButton playBtn, centerBtn, muteBtn, repeatBtn;
    private View buffering;
    private SeekBar seek;
    private TextView posText, durText;
    private long resumeAt = 0;
    private boolean dragging = false;
    private boolean controlsVisible = true;

    @Override
    @OptIn(markerClass = UnstableApi.class)
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        // Barras do sistema visíveis, com ícones claros sobre o fundo preto
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(false);
        setContentView(R.layout.dv_player);

        View root = findViewById(R.id.dv_root);
        videoView = findViewById(R.id.dv_video);
        videoView.setUseController(false);
        videoView.setKeepScreenOn(true);
        top = findViewById(R.id.dv_top);
        bottom = findViewById(R.id.dv_bottom);
        playBtn = findViewById(R.id.dv_play);
        centerBtn = findViewById(R.id.dv_center);
        muteBtn = findViewById(R.id.dv_mute);
        repeatBtn = findViewById(R.id.dv_repeat);
        buffering = findViewById(R.id.dv_buffering);
        seek = findViewById(R.id.dv_seek);
        posText = findViewById(R.id.dv_pos);
        durText = findViewById(R.id.dv_dur);
        TextView title = findViewById(R.id.dv_title);

        // Frutiger, a mesma fonte do app
        Typeface frutiger = ResourcesCompat.getFont(this, R.font.frutiger);
        if (frutiger != null) {
            title.setTypeface(frutiger);
            posText.setTypeface(frutiger);
            durText.setTypeface(frutiger);
        }
        String name = getIntent().getStringExtra(EXTRA_TITLE);
        title.setText(name == null || name.isEmpty() ? "Vídeo" : name);

        // O conteúdo fica entre a barra de status e os botões do sistema
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        findViewById(R.id.dv_touch).setOnClickListener((v) -> setControlsVisible(!controlsVisible));
        findViewById(R.id.dv_back).setOnClickListener((v) -> finish());
        playBtn.setOnClickListener((v) -> togglePlay());
        centerBtn.setOnClickListener((v) -> togglePlay());
        findViewById(R.id.dv_rew).setOnClickListener((v) -> seekBy(-SEEK_STEP_MS));
        findViewById(R.id.dv_fwd).setOnClickListener((v) -> seekBy(SEEK_STEP_MS));
        muteBtn.setOnClickListener((v) -> {
            if (player == null) return;
            boolean mute = player.getVolume() > 0f;
            player.setVolume(mute ? 0f : 1f);
            muteBtn.setImageResource(mute ? R.drawable.dv_ic_mute : R.drawable.dv_ic_volume);
            poke();
        });
        repeatBtn.setOnClickListener((v) -> {
            if (player == null) return;
            boolean on = player.getRepeatMode() != Player.REPEAT_MODE_ONE;
            player.setRepeatMode(on ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
            repeatBtn.setAlpha(on ? 1f : 0.45f);
            poke();
        });

        seek.setMax(1000);
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (fromUser && player != null) posText.setText(format(fraction(progress)));
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {
                dragging = true;
                handler.removeCallbacks(autoHide);
            }

            @Override
            public void onStopTrackingTouch(SeekBar bar) {
                dragging = false;
                if (player != null) player.seekTo(fraction(bar.getProgress()));
                poke();
            }
        });

        if (savedInstanceState != null) resumeAt = savedInstanceState.getLong(STATE_POSITION, 0);
    }

    private long fraction(int progress) {
        long d = player == null ? 0 : Math.max(0, player.getDuration());
        return d * progress / 1000;
    }

    private void startPlayer() {
        Uri uri = getIntent().getData();
        if (uri == null) {
            finish();
            return;
        }
        player = new ExoPlayer.Builder(this).setSeekBackIncrementMs(SEEK_STEP_MS).setSeekForwardIncrementMs(SEEK_STEP_MS).build();
        videoView.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                refreshPlayState();
                if (isPlaying) poke();
                else setControlsVisible(true);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                buffering.setVisibility(state == Player.STATE_BUFFERING ? View.VISIBLE : View.GONE);
                refreshPlayState();
                updateProgress();
            }
        });
        player.setMediaItem(MediaItem.fromUri(uri));
        if (resumeAt > 0) player.seekTo(resumeAt);
        player.setPlayWhenReady(true);
        player.prepare();
        handler.post(ticker);
    }

    private void releasePlayer() {
        handler.removeCallbacks(ticker);
        handler.removeCallbacks(autoHide);
        if (player == null) return;
        resumeAt = player.getCurrentPosition();
        videoView.setPlayer(null);
        player.release();
        player = null;
    }

    private void togglePlay() {
        if (player == null) return;
        if (player.getPlaybackState() == Player.STATE_ENDED) {
            player.seekTo(0);
            player.play();
        } else if (player.isPlaying()) {
            player.pause();
        } else {
            player.play();
        }
    }

    private void seekBy(long delta) {
        if (player == null) return;
        long d = player.getDuration();
        long target = Math.max(0, player.getCurrentPosition() + delta);
        if (d != C.TIME_UNSET) target = Math.min(target, d);
        player.seekTo(target);
        updateProgress();
        poke();
    }

    /** Orbe principal alterna tocar/pausar; o orbe grande central aparece com o vídeo parado. */
    private void refreshPlayState() {
        if (player == null) return;
        boolean playing = player.isPlaying() || (player.getPlayWhenReady() && player.getPlaybackState() == Player.STATE_BUFFERING);
        playBtn.setImageResource(playing ? R.drawable.dv_ic_pause : R.drawable.dv_ic_play);
        playBtn.setPadding(playing ? 0 : dp(4), 0, 0, 0);
        boolean idle = !playing && player.getPlaybackState() != Player.STATE_BUFFERING;
        centerBtn.setVisibility(idle ? View.VISIBLE : View.GONE);
    }

    private void updateProgress() {
        handler.removeCallbacks(ticker);
        if (player == null) return;
        long d = player.getDuration();
        long p = player.getCurrentPosition();
        if (d != C.TIME_UNSET && d > 0) {
            p = Math.min(p, d); // no fim do vídeo a posição pode passar alguns milissegundos da duração
            durText.setText(format(d));
            if (!dragging) {
                posText.setText(format(p));
                seek.setProgress((int) (p * 1000 / d));
                seek.setSecondaryProgress((int) (player.getBufferedPosition() * 1000 / d));
            }
        }
        handler.postDelayed(ticker, 250);
    }

    /** Mostra os controles e agenda o sumiço automático enquanto o vídeo toca. */
    private void poke() {
        setControlsVisible(true);
        handler.removeCallbacks(autoHide);
        if (player != null && player.isPlaying() && !dragging) handler.postDelayed(autoHide, HIDE_DELAY_MS);
    }

    private void setControlsVisible(boolean show) {
        controlsVisible = show;
        for (View v : new View[] { top, bottom }) {
            v.animate().cancel();
            if (show) {
                v.setVisibility(View.VISIBLE);
                v.animate().alpha(1f).setDuration(180).start();
            } else {
                v.animate().alpha(0f).setDuration(220).withEndAction(() -> {
                    if (!controlsVisible) v.setVisibility(View.GONE);
                }).start();
            }
        }
        if (show) {
            handler.removeCallbacks(autoHide);
            if (player != null && player.isPlaying() && !dragging) handler.postDelayed(autoHide, HIDE_DELAY_MS);
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private static String format(long ms) {
        long s = Math.max(0, (ms + 500) / 1000); // mesmo arredondamento para posição e duração
        if (s >= 3600) return String.format(Locale.US, "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60);
        return String.format(Locale.US, "%d:%02d", s / 60, s % 60);
    }

    @Override
    protected void onStart() {
        super.onStart();
        startPlayer();
    }

    @Override
    protected void onStop() {
        super.onStop();
        releasePlayer();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putLong(STATE_POSITION, player != null ? player.getCurrentPosition() : resumeAt);
    }
}
