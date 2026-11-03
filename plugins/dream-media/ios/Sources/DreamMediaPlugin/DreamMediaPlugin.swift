import Foundation
import Capacitor
import Photos
import AVFoundation
import AVKit
import UIKit

/// Galeria nativa do FoldAero no iOS: lista a biblioteca de Fotos, gera miniaturas e
/// arquivos para a WebView (em Caches) e exclui com a confirmação do sistema.
@objc(DreamMediaPlugin)
public class DreamMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DreamMediaPlugin"
    public let jsName = "DreamMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "thumbnails", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "full", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)
    ]

    private let queue = DispatchQueue(label: "dreamview.media", qos: .userInitiated, attributes: .concurrent)
    private let imageManager = PHCachingImageManager()
    private let maxFullCacheBytes: Int64 = 400 * 1024 * 1024

    private lazy var thumbDir: URL = makeDir("dv-thumbs")
    private lazy var fullDir: URL = makeDir("dv-full")

    private func makeDir(_ name: String) -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func safe(_ id: String) -> String {
        return id.replacingOccurrences(of: "/", with: "_")
    }

    private func status() -> String {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: return "granted"
        case .limited: return "limited"
        case .notDetermined: return "prompt"
        default: return "denied"
        }
    }

    // MARK: Permissões

    @objc func info(_ call: CAPPluginCall) {
        // A biblioteca de Fotos não permite renomear arquivos: o app guarda um apelido
        call.resolve(["platform": "ios", "systemDeleteConfirm": true, "canRename": false])
    }

    @objc func checkAccess(_ call: CAPPluginCall) {
        call.resolve(["status": status()])
    }

    @objc func requestAccess(_ call: CAPPluginCall) {
        if PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited {
            // Acesso limitado: abre o seletor do sistema para escolher mais fotos
            DispatchQueue.main.async {
                guard let vc = self.bridge?.viewController else {
                    call.resolve(["status": self.status()])
                    return
                }
                PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: vc) { _ in
                    call.resolve(["status": self.status()])
                }
            }
            return
        }
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in
            call.resolve(["status": self.status()])
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            call.resolve()
        }
    }

    // MARK: Listagem

    @objc func list(_ call: CAPPluginCall) {
        queue.async {
            let albums = self.albumMap()
            let options = PHFetchOptions()
            options.includeAssetSourceTypes = [.typeUserLibrary, .typeCloudShared, .typeiTunesSynced]
            let assets = PHAsset.fetchAssets(with: options)
            var items: [[String: Any]] = []
            items.reserveCapacity(assets.count)
            assets.enumerateObjects { asset, _, _ in
                guard asset.mediaType == .image || asset.mediaType == .video else { return }
                let type: String
                if asset.mediaType == .video {
                    type = "video"
                } else {
                    type = asset.playbackStyle == .imageAnimated ? "gif" : "image"
                }
                let created = asset.creationDate ?? asset.modificationDate ?? Date()
                items.append([
                    "id": asset.localIdentifier,
                    "type": type,
                    "mime": "",
                    "name": "",
                    "date": created.timeIntervalSince1970 * 1000,
                    "mod": Int(asset.modificationDate?.timeIntervalSince1970 ?? 0),
                    "album": albums[asset.localIdentifier] ?? "Câmera",
                    "duration": asset.duration,
                    "w": asset.pixelWidth,
                    "h": asset.pixelHeight
                ])
            }
            call.resolve(["items": items])
        }
    }

    /// Mapeia cada foto para a primeira pasta (álbum) em que aparece.
    private func albumMap() -> [String: String] {
        var map: [String: String] = [:]
        func add(_ collections: PHFetchResult<PHAssetCollection>, _ fixedName: String? = nil) {
            collections.enumerateObjects { collection, _, _ in
                let name = fixedName ?? collection.localizedTitle ?? "Álbum"
                PHAsset.fetchAssets(in: collection, options: nil).enumerateObjects { asset, _, _ in
                    if map[asset.localIdentifier] == nil {
                        map[asset.localIdentifier] = name
                    }
                }
            }
        }
        add(PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .smartAlbumScreenshots, options: nil), "Screenshots")
        add(PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil))
        add(PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumCloudShared, options: nil))
        return map
    }

    // MARK: Miniaturas

    @objc func thumbnails(_ call: CAPPluginCall) {
        let ids = call.getArray("ids", String.self) ?? []
        let side = CGFloat(call.getInt("size") ?? 384)
        queue.async {
            let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
            let options = PHImageRequestOptions()
            options.isSynchronous = true
            options.deliveryMode = .highQualityFormat
            options.resizeMode = .fast
            options.isNetworkAccessAllowed = true
            var out: [String: String] = [:]
            assets.enumerateObjects { asset, _, _ in
                let mod = Int(asset.modificationDate?.timeIntervalSince1970 ?? 0)
                let file = self.thumbDir.appendingPathComponent("\(self.safe(asset.localIdentifier))_\(mod).jpg")
                if !FileManager.default.fileExists(atPath: file.path) {
                    self.imageManager.requestImage(for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill, options: options) { image, _ in
                        if let data = image?.jpegData(compressionQuality: 0.8) {
                            try? data.write(to: file, options: .atomic)
                        }
                    }
                }
                if FileManager.default.fileExists(atPath: file.path) {
                    out[asset.localIdentifier] = file.absoluteString
                }
            }
            call.resolve(["thumbs": out])
        }
    }

    // MARK: Arquivo completo

    @objc func full(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            call.reject("Mídia não encontrada")
            return
        }
        queue.async {
            let name = PHAssetResource.assetResources(for: asset).first?.originalFilename ?? ""
            let base = "\(self.safe(id))_\(Int(asset.modificationDate?.timeIntervalSince1970 ?? 0))"
            let done: (URL?) -> Void = { url in
                if let url = url {
                    call.resolve(["path": url.absoluteString, "name": name])
                } else {
                    call.reject("Não foi possível abrir a mídia")
                }
            }
            if asset.mediaType == .video {
                self.exportVideo(asset, base: base, done: done)
            } else if asset.playbackStyle == .imageAnimated {
                self.exportImageData(asset, file: self.fullDir.appendingPathComponent(base + ".gif"), done: done)
            } else {
                self.exportImage(asset, file: self.fullDir.appendingPathComponent(base + ".jpg"), done: done)
            }
        }
    }

    private func exportImage(_ asset: PHAsset, file: URL, done: @escaping (URL?) -> Void) {
        if FileManager.default.fileExists(atPath: file.path) { return done(file) }
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true
        PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: 2560, height: 2560), contentMode: .aspectFit, options: options) { image, _ in
            if let data = image?.jpegData(compressionQuality: 0.9), (try? data.write(to: file, options: .atomic)) != nil {
                self.pruneFullCache()
                done(file)
            } else {
                done(nil)
            }
        }
    }

    private func exportImageData(_ asset: PHAsset, file: URL, done: @escaping (URL?) -> Void) {
        if FileManager.default.fileExists(atPath: file.path) { return done(file) }
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.isNetworkAccessAllowed = true
        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
            if let data = data, (try? data.write(to: file, options: .atomic)) != nil {
                self.pruneFullCache()
                done(file)
            } else {
                done(nil)
            }
        }
    }

    private func exportVideo(_ asset: PHAsset, base: String, done: @escaping (URL?) -> Void) {
        let file = fullDir.appendingPathComponent(base + ".mp4")
        if FileManager.default.fileExists(atPath: file.path) { return done(file) }
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, _ in
            guard let avAsset = avAsset else { return done(nil) }
            if let urlAsset = avAsset as? AVURLAsset {
                let target = self.fullDir.appendingPathComponent(base + "." + urlAsset.url.pathExtension.lowercased())
                if !FileManager.default.fileExists(atPath: target.path) {
                    try? FileManager.default.copyItem(at: urlAsset.url, to: target)
                }
                self.pruneFullCache()
                return done(FileManager.default.fileExists(atPath: target.path) ? target : nil)
            }
            // Vídeos em câmera lenta chegam como AVComposition: exporta para MP4
            guard let session = AVAssetExportSession(asset: avAsset, presetName: AVAssetExportPresetHighestQuality) else { return done(nil) }
            session.outputURL = file
            session.outputFileType = .mp4
            session.exportAsynchronously {
                self.pruneFullCache()
                done(session.status == .completed ? file : nil)
            }
        }
    }

    /// Mantém o cache de arquivos completos abaixo do limite, apagando os mais antigos.
    private func pruneFullCache() {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: fullDir, includingPropertiesForKeys: keys) else { return }
        var entries = files.compactMap { url -> (URL, Int64, Date)? in
            guard let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, Int64(v.fileSize ?? 0), v.contentModificationDate ?? .distantPast)
        }
        var total = entries.reduce(Int64(0)) { $0 + $1.1 }
        guard total > maxFullCacheBytes else { return }
        entries.sort { $0.2 < $1.2 }
        for entry in entries where total > maxFullCacheBytes {
            try? FileManager.default.removeItem(at: entry.0)
            total -= entry.1
        }
    }

    // MARK: Player nativo

    @objc func playVideo(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            call.reject("Vídeo não encontrado")
            return
        }
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .automatic
        PHImageManager.default().requestPlayerItem(forVideo: asset, options: options) { item, _ in
            guard let item = item else {
                call.reject("Não foi possível abrir o vídeo")
                return
            }
            DispatchQueue.main.async {
                let controller = AVPlayerViewController()
                controller.player = AVPlayer(playerItem: item)
                controller.modalPresentationStyle = .fullScreen
                self.bridge?.viewController?.present(controller, animated: true) {
                    controller.player?.play()
                }
                call.resolve()
            }
        }
    }

    // MARK: Salvar cópia editada

    @objc func save(_ call: CAPPluginCall) {
        guard let base64 = call.getString("data"), let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            call.reject("Imagem vazia")
            return
        }
        let name = call.getString("name") ?? "FoldAero.jpg"
        var placeholder: PHObjectPlaceholder?
        PHPhotoLibrary.shared().performChanges({
            let request = PHAssetCreationRequest.forAsset()
            let options = PHAssetResourceCreationOptions()
            options.originalFilename = name
            request.addResource(with: .photo, data: data, options: options)
            placeholder = request.placeholderForCreatedAsset
        }, completionHandler: { success, error in
            if success {
                call.resolve(["id": placeholder?.localIdentifier ?? "", "name": name])
            } else {
                call.reject("Não foi possível salvar: \(error?.localizedDescription ?? "erro desconhecido")")
            }
        })
    }

    // MARK: Exclusão

    @objc func delete(_ call: CAPPluginCall) {
        let ids = (call.getArray("items", JSObject.self) ?? []).compactMap { $0["id"] as? String }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        guard assets.count > 0 else {
            call.resolve(["deleted": true])
            return
        }
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest.deleteAssets(assets)
        }, completionHandler: { success, _ in
            call.resolve(["deleted": success])
        })
    }
}
