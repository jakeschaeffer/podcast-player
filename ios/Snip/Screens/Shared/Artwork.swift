import ImageIO
import MediaPlayer
import SwiftUI
import UIKit

/// A show's or episode's artwork in a fixed square. The fixed square is what lays out; the image fills it from an
/// overlay, so wide artwork (Latent Space's is 16:9) can never widen the row or the player around it.
struct Artwork: View {
  let url: String?
  let size: CGFloat
  @Environment(\.displayScale) private var scale
  @State private var loaded: (key: String, image: UIImage)?

  private var source: URL? { ArtworkCache.secure(url) }
  private var pixels: Int { ArtworkCache.bucket(size * scale) }
  private var key: String { "\(source?.absoluteString ?? "")@\(pixels)" }

  var body: some View {
    let image = loaded?.key == key ? loaded?.image : source.flatMap { ArtworkCache.shared.cached($0, pixels: pixels) }
    Color.clear
      .frame(width: size, height: size)
      .overlay {
        if let image {
          Image(uiImage: image).resizable().scaledToFill()
        } else {
          Rectangle().fill(.quaternary).overlay(Image(systemName: "waveform").foregroundStyle(.secondary))
        }
      }
      .clipShape(.rect(cornerRadius: size / 8))
      .task(id: key) {
        guard let source, let image = await ArtworkCache.shared.image(source, pixels: pixels) else { return }
        loaded = (key, image)
      }
  }
}

/// Artwork fetched over https (iOS refuses plain http, and some feeds still list their cover that way; Cortex's
/// does), scaled down to the size it is drawn at, and kept: in memory as decoded images, on disk as the original
/// bytes. A list of shows with 3000 px covers (Lex Fridman's is 2 MB) then neither waits for nor holds every
/// full-size image.
final class ArtworkCache {
  static let shared = ArtworkCache()

  private let images = NSCache<NSString, UIImage>()
  private var loading: [String: Task<UIImage?, Never>] = [:]
  private let session: URLSession = {
    let config = URLSessionConfiguration.default
    config.urlCache = URLCache(memoryCapacity: 4 << 20, diskCapacity: 200 << 20)
    config.requestCachePolicy = .returnCacheDataElseLoad
    return URLSession(configuration: config)
  }()

  /// The URL to load: plain http becomes https.
  static func secure(_ string: String?) -> URL? {
    guard let string, var components = URLComponents(string: string) else { return nil }
    if components.scheme?.lowercased() == "http" { components.scheme = "https" }
    return components.url
  }

  /// Pixel sizes come in a few steps, so the same cover at 52 and 64 pt is decoded once.
  static func bucket(_ pixels: CGFloat) -> Int {
    [128, 256, 512, 1024].first { CGFloat($0) >= pixels } ?? 1024
  }

  func cached(_ url: URL, pixels: Int) -> UIImage? {
    images.object(forKey: "\(url.absoluteString)@\(pixels)" as NSString)
  }

  func image(_ url: URL, pixels: Int) async -> UIImage? {
    let key = "\(url.absoluteString)@\(pixels)"
    if let hit = images.object(forKey: key as NSString) { return hit }
    if let pending = loading[key] { return await pending.value }
    let session = self.session
    let task = Task<UIImage?, Never> {
      guard let (data, response) = try? await session.data(from: url),
        ((response as? HTTPURLResponse)?.statusCode ?? 200) < 400
      else { return nil }
      return await Task.detached(priority: .utility) { Self.downsample(data, pixels: pixels) }.value
    }
    loading[key] = task
    let image = await task.value
    loading[key] = nil
    if let image { images.setObject(image, forKey: key as NSString) }
    return image
  }

  /// The lock screen's cover. MediaPlayer calls the handler on its own queue, so it is built outside the main actor:
  /// a closure made in main-actor code would trap there (Swift checks the isolation at runtime).
  nonisolated static func lockScreenArtwork(_ image: UIImage) -> MPMediaItemArtwork {
    MPMediaItemArtwork(boundsSize: image.size) { _ in image }
  }

  nonisolated static func downsample(_ data: Data, pixels: Int) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
    else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: pixels,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
  }
}
