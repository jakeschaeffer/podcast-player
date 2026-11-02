import AVFoundation
import PlayerKit
import SwiftUI

/// The picture of a recording that has one, where the player's artwork goes: a layer on the engine's own player, so
/// the sound never restarts when the screen changes. In the background the layer lets go of the player, which is what
/// keeps the sound playing with the screen off (a player with a layer attached pauses there).
struct VideoSurface: View {
  @Environment(PlayerEngine.self) private var engine
  @Environment(\.scenePhase) private var scenePhase
  /// Rounded like the artwork in the player; 0 for the full screen.
  var cornerRadius: CGFloat = 16

  var body: some View {
    PlayerLayerView(player: scenePhase == .background ? nil : engine.player)
      .aspectRatio(aspect, contentMode: .fit)
      .background(Color.black)
      .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .accessibilityLabel("Video")
  }

  private var aspect: CGFloat {
    guard let w = engine.episode?.asset?.videoWidth, let h = engine.episode?.asset?.videoHeight, w > 0, h > 0 else { return 16 / 9 }
    return CGFloat(w) / CGFloat(h)
  }
}

/// An AVPlayerLayer on any player: the engine's (VideoSurface), or a snip page's preview.
struct PlayerLayerView: UIViewRepresentable {
  let player: AVPlayer?

  func makeUIView(context: Context) -> LayerView { LayerView() }

  func updateUIView(_ view: LayerView, context: Context) {
    if view.playerLayer.player !== player { view.playerLayer.player = player }
  }

  final class LayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    override init(frame: CGRect) {
      super.init(frame: frame)
      playerLayer.videoGravity = .resizeAspect
      backgroundColor = .black
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
  }
}
