import PlayerKit
import SwiftUI

/// The seek bar with the elapsed and remaining time under it. Dragging shows the position under the thumb; the seek
/// happens when the drag ends. `onInteraction` is told of any touch, for a screen that hides its controls by itself.
struct Scrubber: View {
  @Environment(PlayerEngine.self) private var engine
  var onInteraction: () -> Void = {}
  /// Laid over a video: the times in white with a shadow, so they read on a bright frame.
  var onVideo = false
  @State private var scrubbing: Double?

  var body: some View {
    let duration = Double(max(engine.durationMs, 1))
    let shown = scrubbing ?? Double(engine.positionMs)
    VStack(spacing: 2) {
      Slider(
        value: Binding(get: { shown }, set: { scrubbing = $0; onInteraction() }), in: 0...duration,
        onEditingChanged: { editing in
          onInteraction()
          if !editing, let to = scrubbing {
            engine.seek(to: Int(to))
            scrubbing = nil
          }
        })
      HStack {
        Text(Format.clock(Int(shown)))
        Spacer()
        Text("-" + Format.clock(engine.durationMs - Int(shown)))
      }
      .font(.caption.monospacedDigit())
      .foregroundStyle(onVideo ? AnyShapeStyle(.white.opacity(0.9)) : AnyShapeStyle(.secondary))
      .shadow(color: .black.opacity(onVideo ? 0.7 : 0), radius: 3)
    }
  }
}

/// Speed, skip back 15, play or pause, skip forward 30, Snip: the player's controls, the same wherever the player is
/// shown. Snip is the app's main action, so it is the accent button. During a suspected ad break, Skip ad stands in the
/// speed button's place, in its slot's width so the other controls never move; Snip has a slot of the same width at
/// the other end, so the row is symmetric and play sits in the middle of it. `onInteraction` is told of every press.
struct TransportRow: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  var onInteraction: () -> Void = {}
  /// Laid over a video: a shadow under the buttons, so they read on a bright frame.
  var onVideo = false

  /// The app icon's dark, for marks on the accent colour.
  static let ink = Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255)

  var body: some View {
    HStack {
      // One slot for speed and the ad buttons (Skip ad, Undo skip), as wide as the widest of them (kept in the
      // layout unseen), so neither spills onto the button beside it and nothing moves when they come and go.
      let offer = AdOffer.of(engine)
      ZStack(alignment: .leading) {
        adSlot
        Button { press { engine.cycleSpeed() } } label: {
          Text(engine.speed.formatted(.number.precision(.fractionLength(0...2))) + "×")
            .font(.callout.weight(.semibold).monospacedDigit())
            .frame(minWidth: 44, minHeight: 44)
        }
        .opacity(offer == nil ? 1 : 0)
        .allowsHitTesting(offer == nil)
        if let offer {
          Button { press { offer.act(on: engine) } } label: { adButton(offer) }
            .transition(.opacity)
            .id(offer)
        }
      }
      .animation(.easeInOut(duration: 0.25), value: offer)
      Spacer(minLength: 0)
      Button { press { engine.skip(by: -15_000) } } label: { Image(systemName: "gobackward.15").font(.title2) }
      Spacer(minLength: 0)
      Button { press { engine.toggle() } } label: {
        Image(systemName: engine.playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 64))
          .overlay {
            // Waiting for audio: say so instead of showing a pause button over silence.
            if engine.playing && engine.buffering { ProgressView().controlSize(.large).tint(.white) }
          }
      }
      Spacer(minLength: 0)
      Button { press { engine.skip(by: 30_000) } } label: { Image(systemName: "goforward.30").font(.title2) }
      Spacer(minLength: 0)
      // The same slot at this end, with Snip at its edge: with the ends equal, the spacers put play in the middle.
      ZStack(alignment: .trailing) {
        adSlot
        Button {
          press { Task { await model.snip() } }
        } label: {
          Image(systemName: "scissors")
            .font(.title3.weight(.semibold))
            .foregroundStyle(Self.ink)
            .frame(width: 48, height: 48)
            .background(Color.accentColor, in: .circle)
        }
        .accessibilityLabel("Snip")
        .sensoryFeedback(.impact, trigger: model.snipCard.map(ObjectIdentifier.init))
      }
    }
    .buttonStyle(.plain)
    .shadow(color: .black.opacity(onVideo ? 0.6 : 0), radius: 6)
    // Five controls share one row; past the largest ordinary text size they would no longer fit it.
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
  }

  /// Every ad button laid over one another, unseen: what sizes a slot.
  private var adSlot: some View {
    ZStack {
      adButton(.skip)
      adButton(.undo)
    }
    .hidden()
  }

  private func adButton(_ offer: AdOffer) -> some View {
    Text(offer.title)
      .font(.footnote.weight(.bold))
      .foregroundStyle(onVideo ? Color.white : Color.primary)
      .padding(.horizontal, 10)
      .frame(height: 34)
      .overlay { Capsule().stroke(Color.accentColor, lineWidth: 1.5) }
      .contentShape(.capsule)
      .fixedSize()
  }

  private func press(_ action: () -> Void) {
    onInteraction()
    action()
  }
}
