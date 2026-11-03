# FoldAero

Galeria de fotos, vídeos e GIFs com a estética Windows XP / Vista / 7, para Android e iPhone (Capacitor).
Um app da AquariusFresh Labs, de código aberto: as mídias são lidas e organizadas no próprio aparelho e
nunca são enviadas para nenhum servidor.

## Estrutura

- `www/`: o app (HTML, CSS e JS puros). Também roda no navegador, com importação manual de arquivos.
- `plugins/dream-media/`: plugin nativo que lê a galeria do aparelho (MediaStore no Android, Photos no iOS),
  gera miniaturas, renomeia, salva cópias editadas, abre vídeos no player nativo (Media3 / AVPlayer)
  e exclui com a confirmação do sistema.
- `android/`, `ios/`: projetos nativos gerados pelo Capacitor.
- `scripts/gen-icons.ps1`: regenera ícones e telas de abertura a partir de `www/assets/logo.png`.

O identificador interno continua `com.dreamview.gallery` para que as atualizações instalem por cima das versões
anteriores sem perder favoritos, pastas e cores.

## Android (APK)

Requer JDK 21 e Android SDK (36).

```
npm install
npx cap sync android
cd android
gradlew.bat assembleRelease
```

O APK fica em `android/app/build/outputs/apk/release/app-release.apk`. Ele é assinado com a chave local de
desenvolvimento; para a Play Store, configure uma chave de lançamento própria.

## iPhone

Precisa de um Mac com Xcode:

```
npm install
npx cap sync ios
npx cap open ios
```

No Xcode, escolha o seu time de assinatura (Signing & Capabilities) e rode no aparelho.

## Navegador

Sirva a pasta `www/` por HTTP (ex.: `python -m http.server 8080 --directory www`).
